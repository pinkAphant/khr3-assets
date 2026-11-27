import {
    authHeaders,
    collectManifestAssets,
    normalizeVaultKey,
    normalizeVaultPrefix,
    resolveVaultBaseUrl,
    type AssetVaultClient,
    type AssetVaultOptions,
    type RenameAssetParams,
    type VaultAssetEntry,
    type VaultManifest,
    type VaultTreeResponse,
} from "./client-normalize.js";

export {
    DEFAULT_VAULT_URL,
    KOLMO_ASSETS_URL,
    normalizeBaseUrl,
    normalizeVaultKey,
    normalizeVaultPrefix,
    resolveVaultBaseUrl,
} from "./client-normalize.js";

export type {
    AssetVaultClient,
    AssetVaultOptions,
    RenameAssetParams,
    VaultAssetEntry,
    VaultManifest,
    VaultTreeResponse,
} from "./client-normalize.js";

export function createAssetVault(baseUrlOrOpts?: string | AssetVaultOptions): AssetVaultClient {
    const opts: AssetVaultOptions = typeof baseUrlOrOpts === "string"
        ? { baseUrl: baseUrlOrOpts }
        : (baseUrlOrOpts ?? {});
    const root = resolveVaultBaseUrl(opts.baseUrl);
    const fetchFn: typeof fetch = opts.fetch ?? globalThis.fetch;
    const url = (key: string): string => `${root}/assets/${normalizeVaultKey(key)}`;
    async function manifest(init?: RequestInit): Promise<VaultManifest> {
        const res = await fetchFn(`${root}/assets/manifest.json`, init);
        if (!res.ok)
            throw new Error(`HTTP ${res.status} fetching manifest from ${root}`);
        const raw = (await res.json()) as VaultManifest;
        return { ...raw, assets: collectManifestAssets(raw, url) };
    }
    async function list(category?: string, init?: RequestInit): Promise<VaultAssetEntry[]> {
        const m = await manifest(init);
        const cleanCat = category?.trim().replace(/^\/+|\/+$/g, "").replace(/^assets(?:\/|$)/, "");
        if (!cleanCat)
            return m.assets;
        return m.assets.filter((a) => a.category === cleanCat || a.key.startsWith(`${cleanCat}/`));
    }
    async function listPrefix(prefix = "", init?: RequestInit): Promise<VaultTreeResponse> {
        const norm = normalizeVaultPrefix(prefix);
        const res = await fetchFn(`${root}/api/tree${norm ? `?prefix=${encodeURIComponent(norm)}` : ""}`, init);
        if (!res.ok)
            throw new Error(`HTTP ${res.status} listing tree prefix "${norm}" from ${root}`);
        return (await res.json()) as VaultTreeResponse;
    }
    async function fetchBytes(key: string, init?: RequestInit): Promise<ArrayBuffer> {
        const res = await fetchFn(url(key), init);
        if (!res.ok)
            throw new Error(`HTTP ${res.status} fetching ${url(key)}`);
        return await res.arrayBuffer();
    }
    async function upload(key: string, bytes: ArrayBuffer | Uint8Array, token?: string): Promise<Response> {
        const clean = normalizeVaultKey(key);
        const lower = clean.toLowerCase();
        const contentType = lower.endsWith(".glb")
            ? "model/gltf-binary"
            : lower.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
        const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const body = new Uint8Array(new ArrayBuffer(src.byteLength));
        body.set(src);
        return await fetchFn(`${root}/admin/assets/${clean}`, {
            method: "PUT",
            headers: authHeaders(token, { "Content-Type": contentType }),
            body,
        });
    }
    async function deleteKey(key: string, token?: string): Promise<Response> {
        const clean = normalizeVaultKey(key);
        return await fetchFn(`${root}/admin/assets/${clean}`, { method: "DELETE", headers: authHeaders(token) });
    }
    async function renameKey(params: RenameAssetParams, token?: string): Promise<Response> {
        const from = normalizeVaultKey(params.from);
        const to = normalizeVaultKey(params.to);
        if (from === to)
            throw new Error("Source and destination keys must differ");
        return await fetchFn(`${root}/admin/rename`, {
            method: "POST",
            headers: authHeaders(token, { "Content-Type": "application/json" }),
            body: JSON.stringify({ from, to, overwrite: Boolean(params.overwrite) }),
        });
    }
    async function createFolder(prefix: string, token?: string): Promise<Response> {
        const norm = normalizeVaultPrefix(prefix);
        if (!norm)
            throw new Error("createFolder requires a non-empty prefix");
        return await fetchFn(`${root}/admin/folders`, {
            method: "POST",
            headers: authHeaders(token, { "Content-Type": "application/json" }),
            body: JSON.stringify({ prefix: norm }),
        });
    }
    return { baseUrl: root, url, manifest, list, listPrefix, fetchBytes, upload, put: upload, deleteKey, delete: deleteKey, renameKey, createFolder };
}
