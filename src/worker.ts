import { createAccessAuthorizer, type JwksFetcher } from "./access.js";
import { CORS_HEADERS, handleAssetRead, resolveContentType, sanitizeKey, sanitizePrefix } from "./r2-http.js";
import { handleValidatedUpload } from "./r2-upload.js";

export type { JwksFetcher } from "./access.js";

export interface R2RangeInfo {
    offset?: number;
    length?: number;
    suffix?: number;
}

export interface R2ObjectMeta {
    key: string;
    size: number;
    httpEtag: string;
    uploaded?: Date;
    httpMetadata?: {
        contentType?: string;
    };
    range?: R2RangeInfo;
}

export interface R2ObjectWithBody extends R2ObjectMeta {
    body: ReadableStream<Uint8Array> | null;
}

export interface R2ListResult {
    objects: R2ObjectMeta[];
    delimitedPrefixes?: string[];
    truncated?: boolean;
    cursor?: string;
}

export interface R2BucketBinding {
    head(key: string): Promise<R2ObjectMeta | null>;
    get(key: string, options?: { range?: Headers | { offset: number; length: number } }): Promise<R2ObjectWithBody | null>;
    put(
        key: string,
        value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | null,
        options?: { httpMetadata?: { contentType?: string } },
    ): Promise<R2ObjectMeta | null>;
    delete(key: string): Promise<void>;
    list?(options?: { prefix?: string; delimiter?: string; limit?: number; cursor?: string }): Promise<R2ListResult>;
}

export interface AssetsFetcher {
    fetch(request: Request): Promise<Response>;
}

export interface VaultWorkerEnv {
    ASSETS_BUCKET: R2BucketBinding;
    SITE_ASSETS?: AssetsFetcher;
    VAULT_WRITE_TOKEN?: string;
    CF_ACCESS_AUD?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_CERTS_JSON?: string;
}

export interface VaultWorkerOptions {
    prefix?: string;
    maxUploadBytes?: number;
    jwksTtlMs?: number;
    jwksFetcher?: JwksFetcher;
}

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function createVaultWorker(options?: VaultWorkerOptions): { fetch(req: Request, env: VaultWorkerEnv): Promise<Response> } {
    const rawPrefix = (options?.prefix ?? "/assets/").trim().replace(/^\/+|\/+$/g, "");
    const prefix = rawPrefix ? `/${rawPrefix}/` : "/assets/";
    const maxUploadBytes = options?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const auth = createAccessAuthorizer(options);

    async function handleTree(req: Request, env: VaultWorkerEnv, url: URL): Promise<Response> {
        if (req.method === "OPTIONS")
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        if (req.method !== "GET") {
            return new Response("Method Not Allowed", { status: 405, headers: { ...CORS_HEADERS, Allow: "GET, OPTIONS" } });
        }
        const treePrefix = sanitizePrefix(url.searchParams.get("prefix"));
        if (treePrefix === null)
            return Response.json({ error: "Invalid prefix" }, { status: 400, headers: CORS_HEADERS });
        if (!env.ASSETS_BUCKET.list) {
            return Response.json({ prefix: treePrefix, folders: [], items: [] }, { status: 200, headers: CORS_HEADERS });
        }
        const folderSet = new Set<string>();
        const allObjects: R2ObjectMeta[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
            const listed = await env.ASSETS_BUCKET.list({ prefix: treePrefix, delimiter: "/", cursor });
            for (const f of listed.delimitedPrefixes ?? [])
                folderSet.add(f);
            for (const o of listed.objects ?? [])
                allObjects.push(o);
            if (!listed.truncated || !listed.cursor || seenCursors.has(listed.cursor))
                break;
            seenCursors.add(listed.cursor);
            cursor = listed.cursor;
        }
        const items = allObjects
            .filter((o) => !o.key.endsWith("/.keep") && o.key !== treePrefix)
            .map((o) => ({
                key: o.key,
                size: o.size,
                etag: o.httpEtag,
                contentType: resolveContentType(o.key) ?? o.httpMetadata?.contentType ?? "application/octet-stream",
            }));
        return Response.json({ prefix: treePrefix, folders: [...folderSet].sort(), items }, { status: 200, headers: CORS_HEADERS });
    }

    async function handleAdmin(req: Request, env: VaultWorkerEnv, pathname: string): Promise<Response> {
        if (req.method === "OPTIONS")
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        const denied = await auth.checkWriteAuth(req, env, CORS_HEADERS);
        if (denied) {
            await req.body?.cancel().catch(() => { });
            return denied;
        }
        if (pathname.startsWith("/admin/assets/")) {
            const key = sanitizeKey(pathname.slice("/admin/assets/".length));
            if (!key)
                return Response.json({ error: "Invalid asset key" }, { status: 400, headers: CORS_HEADERS });
            if (req.method === "GET" || req.method === "HEAD")
                return handleAssetRead(req, env.ASSETS_BUCKET, key);
            if (req.method === "PUT")
                return handleValidatedUpload(req, env.ASSETS_BUCKET, key, maxUploadBytes);
            if (req.method === "DELETE") {
                await env.ASSETS_BUCKET.delete(key);
                return new Response(null, { status: 204, headers: CORS_HEADERS });
            }
            return new Response("Method Not Allowed", {
                status: 405,
                headers: { ...CORS_HEADERS, Allow: "GET, HEAD, PUT, DELETE, OPTIONS" },
            });
        }
        if (pathname === "/admin/folders") {
            if (req.method !== "POST") {
                return new Response("Method Not Allowed", { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } });
            }
            const body = (await req.json().catch(() => null)) as { prefix?: string } | null;
            const folderPrefix = sanitizePrefix(body?.prefix ?? null);
            if (!folderPrefix)
                return Response.json({ error: "Invalid folder prefix" }, { status: 400, headers: CORS_HEADERS });
            const markerKey = `${folderPrefix}.keep`;
            await env.ASSETS_BUCKET.put(markerKey, new Uint8Array(0), { httpMetadata: { contentType: "application/x-empty" } });
            return Response.json({ ok: true, prefix: folderPrefix, markerKey }, { status: 201, headers: CORS_HEADERS });
        }
        if (pathname === "/admin/rename") {
            if (req.method !== "POST") {
                return new Response("Method Not Allowed", { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } });
            }
            const body = (await req.json().catch(() => null)) as { from?: string; to?: string; overwrite?: boolean } | null;
            const fromKey = body?.from ? sanitizeKey(body.from) : null;
            const toKey = body?.to ? sanitizeKey(body.to) : null;
            if (!fromKey || !toKey || fromKey === toKey) {
                return Response.json({ error: "Invalid rename keys" }, { status: 400, headers: CORS_HEADERS });
            }
            const dstType = resolveContentType(toKey);
            if (!dstType || resolveContentType(fromKey) !== dstType) {
                return Response.json({ error: "Only .glb and .json asset keys of matching type may be renamed" }, { status: 415, headers: CORS_HEADERS });
            }
            const src = await env.ASSETS_BUCKET.get(fromKey);
            if (!src)
                return Response.json({ error: "Source key not found", key: fromKey }, { status: 404, headers: CORS_HEADERS });
            if (!body?.overwrite && (await env.ASSETS_BUCKET.head(toKey))) {
                await src.body?.cancel().catch(() => { });
                return Response.json({ error: "Destination key already exists", key: toKey }, { status: 409, headers: CORS_HEADERS });
            }
            type FixedLenCtor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;
            const FixedLen = (globalThis as unknown as { FixedLengthStream?: FixedLenCtor }).FixedLengthStream;
            let putBody: ReadableStream<Uint8Array> | Uint8Array | null = src.body;
            if (src.body) {
                if (typeof FixedLen === "function" && src.size > 0) {
                    const fixed = new FixedLen(src.size);
                    void src.body.pipeTo(fixed.writable).catch(() => { });
                    putBody = fixed.readable;
                }
                else {
                    putBody = new Uint8Array(await new Response(src.body).arrayBuffer());
                }
            }
            await env.ASSETS_BUCKET.put(toKey, putBody, { httpMetadata: { contentType: dstType } });
            await env.ASSETS_BUCKET.delete(fromKey);
            return Response.json({ ok: true, from: fromKey, to: toKey }, { status: 200, headers: CORS_HEADERS });
        }
        return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }

    return {
        async fetch(req: Request, env: VaultWorkerEnv): Promise<Response> {
            const url = new URL(req.url);
            if (url.pathname === "/api/tree")
                return handleTree(req, env, url);
            if (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
                return handleAdmin(req, env, url.pathname);
            if (url.pathname.startsWith(prefix)) {
                if (req.method === "OPTIONS") {
                    return new Response(null, { status: 204, headers: { ...CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" } });
                }
                if (req.method !== "GET" && req.method !== "HEAD") {
                    await req.body?.cancel().catch(() => { });
                    return new Response("Method Not Allowed", {
                        status: 405,
                        headers: { ...CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" },
                    });
                }
                const key = sanitizeKey(url.pathname.slice(prefix.length));
                if (!key)
                    return Response.json({ error: "Invalid asset key" }, { status: 400, headers: CORS_HEADERS });
                return handleAssetRead(req, env.ASSETS_BUCKET, key);
            }
            if (env.SITE_ASSETS)
                return env.SITE_ASSETS.fetch(req);
            return new Response("Not Found", { status: 404 });
        },
    };
}
