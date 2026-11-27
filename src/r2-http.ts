import type { R2BucketBinding, R2ObjectMeta } from "./worker.js";

export const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type, If-None-Match, Authorization, Cf-Access-Jwt-Assertion",
    "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
};

export function resolveContentType(key: string): string | null {
    const lower = key.toLowerCase();
    if (lower.endsWith(".glb"))
        return "model/gltf-binary";
    if (lower.endsWith(".json"))
        return "application/json; charset=utf-8";
    return null;
}

function decodePercent(raw: string): string | null {
    let cur = raw;
    for (let i = 0; i < 3; i++) {
        try {
            const next = decodeURIComponent(cur);
            if (next === cur)
                return cur;
            cur = next;
        }
        catch {
            return null;
        }
    }
    return /%[0-9a-fA-F]{2}/.test(cur) ? null : cur;
}

export function sanitizeKey(raw: string): string | null {
    const decoded = decodePercent(raw.trim());
    if (!decoded || /[\x00-\x1f\x7f\\]/.test(decoded) || decoded.includes("//"))
        return null;
    const withoutLead = decoded.replace(/^\//, "");
    const key = withoutLead.startsWith("assets/") ? withoutLead.slice("assets/".length) : withoutLead;
    if (!key || key.startsWith("/") || key.endsWith("/") || key.includes(".."))
        return null;
    if (key.split("/").some((seg) => !seg || seg === "." || seg === ".."))
        return null;
    return key;
}

export function sanitizePrefix(raw: string | null): string | null {
    if (!raw)
        return "";
    const decoded = decodePercent(raw.trim());
    if (decoded === null || /[\x00-\x1f\x7f\\]/.test(decoded) || decoded.includes("//") || decoded.includes("..")) {
        return null;
    }
    const withoutLead = decoded.replace(/^\//, "");
    const withoutAssets = withoutLead === "assets" || withoutLead === "assets/"
        ? ""
        : withoutLead.startsWith("assets/") ? withoutLead.slice("assets/".length) : withoutLead;
    const clean = withoutAssets.replace(/\/$/, "");
    if (!clean)
        return "";
    if (clean.split("/").some((seg) => !seg || seg === "." || seg === ".."))
        return null;
    return `${clean}/`;
}

export function matchesIfNoneMatch(headerVal: string | null, etag: string): boolean {
    if (!headerVal || !etag)
        return false;
    const target = etag.trim().replace(/^W\//, "");
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i <= headerVal.length; i++) {
        const ch = i < headerVal.length ? headerVal[i] : ",";
        if (ch === '"') {
            inQuotes = !inQuotes;
            cur += ch;
        }
        else if (ch === "," && !inQuotes) {
            const tok = cur.trim();
            if (tok === "*" || (tok.length > 0 && tok.replace(/^W\//, "") === target))
                return true;
            cur = "";
        }
        else {
            cur += ch;
        }
    }
    return false;
}

export function parseByteRange(rangeHeader: string, size: number): { offset: number; length: number } | null {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!m || size <= 0 || (m[1] === "" && m[2] === ""))
        return null;
    if (m[1] === "") {
        const suffix = Number(m[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
            return null;
        const length = Math.min(suffix, size);
        return { offset: size - length, length };
    }
    const start = Number(m[1]);
    if (!Number.isSafeInteger(start) || start >= size)
        return null;
    if (m[2] === "")
        return { offset: start, length: size - start };
    const end = Number(m[2]);
    if (!Number.isSafeInteger(end) || end < start)
        return null;
    return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

function sliceStream(body: ReadableStream<Uint8Array>, offset: number, length: number): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let pos = 0;
    let remaining = length;
    return new ReadableStream<Uint8Array>({
        async pull(c) {
            while (remaining > 0) {
                const r = await reader.read();
                if (r.done)
                    break;
                const chunk = r.value;
                if (!chunk || chunk.byteLength === 0)
                    continue;
                const sliceStart = Math.max(0, offset - pos);
                const sliceEnd = Math.min(chunk.byteLength, sliceStart + remaining);
                pos += chunk.byteLength;
                if (sliceEnd > sliceStart) {
                    const sub = chunk.subarray(sliceStart, sliceEnd);
                    remaining -= sub.byteLength;
                    c.enqueue(sub);
                    if (remaining <= 0)
                        await reader.cancel().catch(() => { });
                    return;
                }
            }
            c.close();
        },
        async cancel() {
            await reader.cancel().catch(() => { });
        },
    });
}

export async function handleAssetRead(req: Request, bucket: R2BucketBinding, key: string): Promise<Response> {
    const buildHeaders = (meta: R2ObjectMeta): Headers => {
        const h = new Headers(CORS_HEADERS);
        h.set("Content-Type", resolveContentType(key) ?? meta.httpMetadata?.contentType ?? "application/octet-stream");
        h.set("X-Content-Type-Options", "nosniff");
        h.set("Cache-Control", "public, max-age=60, must-revalidate");
        h.set("ETag", meta.httpEtag);
        h.set("Accept-Ranges", "bytes");
        return h;
    };
    if (req.method === "HEAD") {
        const meta = await bucket.head(key);
        if (!meta)
            return Response.json({ error: "Not found", key }, { status: 404, headers: CORS_HEADERS });
        const headers = buildHeaders(meta);
        if (matchesIfNoneMatch(req.headers.get("if-none-match"), meta.httpEtag)) {
            return new Response(null, { status: 304, headers });
        }
        headers.set("Content-Length", String(meta.size));
        return new Response(null, { status: 200, headers });
    }
    const rangeHeader = req.headers.get("range");
    if (rangeHeader !== null) {
        const meta = await bucket.head(key);
        if (!meta)
            return Response.json({ error: "Not found", key }, { status: 404, headers: CORS_HEADERS });
        const headers = buildHeaders(meta);
        if (matchesIfNoneMatch(req.headers.get("if-none-match"), meta.httpEtag)) {
            return new Response(null, { status: 304, headers });
        }
        const parsed = parseByteRange(rangeHeader, meta.size);
        if (!parsed) {
            return new Response("Range Not Satisfiable", {
                status: 416,
                headers: { ...CORS_HEADERS, "Content-Range": `bytes */${meta.size}` },
            });
        }
        const obj = await bucket.get(key, { range: parsed });
        if (!obj)
            return Response.json({ error: "Not found", key }, { status: 404, headers: CORS_HEADERS });
        const body = obj.range || !obj.body ? obj.body : sliceStream(obj.body, parsed.offset, parsed.length);
        headers.set("Content-Range", `bytes ${parsed.offset}-${parsed.offset + parsed.length - 1}/${meta.size}`);
        headers.set("Content-Length", String(parsed.length));
        return new Response(body, { status: 206, headers });
    }
    const obj = await bucket.get(key);
    if (!obj)
        return Response.json({ error: "Not found", key }, { status: 404, headers: CORS_HEADERS });
    const headers = buildHeaders(obj);
    if (matchesIfNoneMatch(req.headers.get("if-none-match"), obj.httpEtag)) {
        await obj.body?.cancel().catch(() => { });
        return new Response(null, { status: 304, headers });
    }
    headers.set("Content-Length", String(obj.size));
    return new Response(obj.body, { status: 200, headers });
}
