import { CORS_HEADERS, resolveContentType } from "./r2-http.js";
import type { R2BucketBinding } from "./worker.js";

const GLB_MAGIC = 0x46546c67;

type FixedLengthStreamCtor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

export async function handleValidatedUpload(req: Request, bucket: R2BucketBinding, key: string, maxBytes: number): Promise<Response> {
    const contentType = resolveContentType(key);
    if (!contentType) {
        await req.body?.cancel().catch(() => { });
        return Response.json({ error: "Only .glb and .json uploads are allowed" }, { status: 415, headers: CORS_HEADERS });
    }
    const clHeader = req.headers.get("content-length");
    let declaredLength: number | null = null;
    if (clHeader !== null) {
        const trimmed = clHeader.trim();
        const isDigits = /^\d+$/.test(trimmed);
        const cl = isDigits ? Number(trimmed) : Number.NaN;
        if (!isDigits || !Number.isSafeInteger(cl) || cl < 0 || cl > maxBytes) {
            await req.body?.cancel().catch(() => { });
            const status = isDigits && cl > maxBytes ? 413 : 400;
            const error = status === 413 ? "Upload exceeds maximum size" : "Invalid Content-Length";
            return Response.json({ error }, { status, headers: CORS_HEADERS });
        }
        declaredLength = cl;
    }
    const isGlb = key.toLowerCase().endsWith(".glb");
    if (!req.body) {
        if (isGlb)
            return Response.json({ error: "Invalid GLB binary header" }, { status: 400, headers: CORS_HEADERS });
        if (declaredLength !== null && declaredLength !== 0)
            return Response.json({ error: "Content-Length mismatch" }, { status: 400, headers: CORS_HEADERS });
        await bucket.put(key, new Uint8Array(0), { httpMetadata: { contentType } });
        return Response.json({ ok: true, key, size: 0 }, { status: 201, headers: CORS_HEADERS });
    }
    const reader = req.body.getReader();
    const headChunks: Uint8Array[] = [];
    let buffered = 0;
    let done = false;
    while (buffered < (isGlb ? 20 : 1)) {
        const r = await reader.read();
        if (r.done) {
            done = true;
            break;
        }
        if (r.value && r.value.byteLength > 0) {
            buffered += r.value.byteLength;
            if (buffered > maxBytes) {
                await reader.cancel().catch(() => { });
                return Response.json({ error: "Upload exceeds maximum size" }, { status: 413, headers: CORS_HEADERS });
            }
            headChunks.push(r.value);
        }
    }
    let glbLen: number | null = null;
    if (isGlb) {
        const hdr = new Uint8Array(12);
        let off = 0;
        for (const ch of headChunks) {
            const take = Math.min(ch.byteLength, 12 - off);
            hdr.set(ch.subarray(0, take), off);
            off += take;
            if (off >= 12)
                break;
        }
        const dv = new DataView(hdr.buffer);
        const hasMagic = buffered >= 12 && dv.getUint32(0, true) === GLB_MAGIC && dv.getUint32(4, true) === 2;
        const len = hasMagic ? dv.getUint32(8, true) : 0;
        if (hasMagic && len > maxBytes) {
            await reader.cancel().catch(() => { });
            return Response.json({ error: "Upload exceeds maximum size" }, { status: 413, headers: CORS_HEADERS });
        }
        if (!hasMagic || len < 20 || buffered < 20) {
            await reader.cancel().catch(() => { });
            return Response.json({ error: "Invalid GLB binary header (expected glTF v2)" }, { status: 400, headers: CORS_HEADERS });
        }
        glbLen = len;
    }
    if (declaredLength !== null && glbLen !== null && declaredLength !== glbLen) {
        await reader.cancel().catch(() => { });
        return Response.json({ error: "Content-Length mismatch" }, { status: 400, headers: CORS_HEADERS });
    }
    const expectedLength = declaredLength ?? glbLen;
    if (expectedLength !== null && (buffered > expectedLength || (done && buffered !== expectedLength))) {
        await reader.cancel().catch(() => { });
        return Response.json({ error: "Content-Length mismatch" }, { status: 400, headers: CORS_HEADERS });
    }
    let totalBytes = buffered;
    let overflowed = false;
    let lengthMismatch = false;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            for (const ch of headChunks)
                c.enqueue(ch);
            if (done)
                c.close();
        },
        async pull(c) {
            const r = await reader.read();
            if (r.done) {
                if (expectedLength !== null && totalBytes !== expectedLength) {
                    lengthMismatch = true;
                    return c.error(new Error("Content-Length mismatch"));
                }
                return c.close();
            }
            if (r.value && r.value.byteLength > 0) {
                totalBytes += r.value.byteLength;
                if (totalBytes > maxBytes) {
                    overflowed = true;
                    await reader.cancel().catch(() => { });
                    return c.error(new Error("Upload exceeds maximum size"));
                }
                if (expectedLength !== null && totalBytes > expectedLength) {
                    lengthMismatch = true;
                    await reader.cancel().catch(() => { });
                    return c.error(new Error("Content-Length mismatch"));
                }
                c.enqueue(r.value);
            }
        },
        async cancel() {
            await reader.cancel().catch(() => { });
        },
    });
    try {
        const FixedLen = (globalThis as unknown as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
        let putBody: ReadableStream<Uint8Array> | Uint8Array = stream;
        if (typeof FixedLen === "function") {
            if (declaredLength !== null && declaredLength > 0) {
                const fixed = new FixedLen(declaredLength);
                void stream.pipeTo(fixed.writable).catch(() => { });
                putBody = fixed.readable;
            }
            else {
                putBody = new Uint8Array(await new Response(stream).arrayBuffer());
            }
        }
        const meta = await bucket.put(key, putBody, { httpMetadata: { contentType } });
        return Response.json({ ok: true, key, size: meta?.size ?? totalBytes }, { status: 201, headers: CORS_HEADERS });
    }
    catch (err) {
        if (overflowed)
            return Response.json({ error: "Upload exceeds maximum size" }, { status: 413, headers: CORS_HEADERS });
        if (lengthMismatch)
            return Response.json({ error: "Content-Length mismatch" }, { status: 400, headers: CORS_HEADERS });
        const msg = err instanceof Error ? err.message : "";
        if (/fixedlength|content-length|length mismatch|truncated/i.test(msg))
            return Response.json({ error: "Content-Length mismatch" }, { status: 400, headers: CORS_HEADERS });
        throw new Error("Failed to store asset in R2");
    }
}
