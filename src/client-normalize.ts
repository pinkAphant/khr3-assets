export const DEFAULT_VAULT_URL = "https://khr3.optimuspi.workers.dev";
export const KOLMO_ASSETS_URL = "https://kolmo-assets.pifreak.com";

export interface VaultAssetEntry {
    key: string;
    url?: string;
    size?: number;
    etag?: string;
    uploaded?: string;
    contentType?: string;
    category?: string;
    [k: string]: unknown;
}

export interface VaultManifest {
    baseUrl?: string;
    count?: number;
    assets: VaultAssetEntry[];
    categories?: Record<string, Array<string | VaultAssetEntry>>;
    [k: string]: unknown;
}

export interface VaultTreeResponse {
    prefix: string;
    folders: string[];
    items: VaultAssetEntry[];
}

export interface RenameAssetParams {
    from: string;
    to: string;
    overwrite?: boolean;
}

export interface AssetVaultOptions {
    readonly baseUrl?: string;
    readonly fetch?: typeof fetch;
}

export interface AssetVaultClient {
    readonly baseUrl: string;
    url(key: string): string;
    manifest(init?: RequestInit): Promise<VaultManifest>;
    list(category?: string, init?: RequestInit): Promise<VaultAssetEntry[]>;
    listPrefix(prefix?: string, init?: RequestInit): Promise<VaultTreeResponse>;
    fetchBytes(key: string, init?: RequestInit): Promise<ArrayBuffer>;
    upload(key: string, bytes: ArrayBuffer | Uint8Array, token?: string): Promise<Response>;
    put(key: string, bytes: ArrayBuffer | Uint8Array, token?: string): Promise<Response>;
    deleteKey(key: string, token?: string): Promise<Response>;
    delete(key: string, token?: string): Promise<Response>;
    renameKey(params: RenameAssetParams, token?: string): Promise<Response>;
    createFolder(prefix: string, token?: string): Promise<Response>;
}

export function normalizeBaseUrl(raw: string): string {
    const b = raw.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(b))
        throw new Error(`Invalid asset vault baseUrl: ${raw}`);
    return b;
}

export function resolveVaultBaseUrl(overrideUrl?: string): string {
    if (overrideUrl !== undefined)
        return normalizeBaseUrl(overrideUrl);
    const procEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
    const envUrl =
        (procEnv?.KHR3_VAULT_URL?.trim() || undefined) ??
        (procEnv?.VAULT_URL?.trim() || undefined) ??
        (metaEnv?.VITE_KHR3_VAULT_URL?.trim() || undefined);
    return normalizeBaseUrl(envUrl ?? DEFAULT_VAULT_URL);
}

function decodePercentStrict(raw: string, label: string): string {
    let cur = raw;
    for (let i = 0; i < 3; i++) {
        let next: string;
        try {
            next = decodeURIComponent(cur);
        }
        catch {
            throw new Error(`Invalid ${label}: ${raw}`);
        }
        if (next === cur)
            return cur;
        cur = next;
    }
    if (/%[0-9a-fA-F]{2}/.test(cur))
        throw new Error(`Invalid ${label}: ${raw}`);
    return cur;
}

export function normalizeVaultKey(key: string): string {
    const decoded = decodePercentStrict(key.trim(), "asset vault key");
    if (!decoded || /[\x00-\x1f\x7f\\]/.test(decoded) || decoded.includes("//")) {
        throw new Error(`Invalid asset vault key: ${key}`);
    }
    const withoutSlash = decoded.replace(/^\//, "");
    const clean = withoutSlash.startsWith("assets/") ? withoutSlash.slice("assets/".length) : withoutSlash;
    if (!clean || clean.startsWith("/") || clean.endsWith("/") || clean.includes("..")) {
        throw new Error(`Invalid asset vault key: ${key}`);
    }
    if (clean.split("/").some((seg) => !seg || seg === "." || seg === "..")) {
        throw new Error(`Invalid asset vault key: ${key}`);
    }
    return clean;
}

export function normalizeVaultPrefix(prefix = ""): string {
    const trimmed = prefix.trim();
    if (!trimmed)
        return "";
    const decoded = decodePercentStrict(trimmed, "asset vault prefix");
    if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.includes("//") || decoded.includes("..")) {
        throw new Error(`Invalid asset vault prefix: ${prefix}`);
    }
    const withoutLead = decoded.replace(/^\//, "");
    const withoutAssets = withoutLead === "assets" || withoutLead === "assets/"
        ? ""
        : withoutLead.startsWith("assets/") ? withoutLead.slice("assets/".length) : withoutLead;
    const clean = withoutAssets.replace(/\/$/, "");
    if (!clean)
        return "";
    if (clean.split("/").some((seg) => !seg || seg === "." || seg === "..")) {
        throw new Error(`Invalid asset vault prefix: ${prefix}`);
    }
    return `${clean}/`;
}

export function authHeaders(token?: string, extra?: Record<string, string>): Record<string, string> {
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra ?? {}) };
}

function normalizeEntry(raw: unknown, urlFor: (key: string) => string, fallbackCategory?: string): VaultAssetEntry | null {
    if (typeof raw === "string") {
        const trimmed = raw.trim().replace(/^\//, "").replace(/^assets\//, "");
        if (!trimmed)
            return null;
        const key = normalizeVaultKey(fallbackCategory && !trimmed.includes("/") ? `${fallbackCategory}/${trimmed}` : trimmed);
        const category = fallbackCategory ?? (key.includes("/") ? key.slice(0, key.indexOf("/")) : undefined);
        return { key, url: urlFor(key), ...(category ? { category } : {}) };
    }
    if (!raw || typeof raw !== "object")
        return null;
    const rec = raw as Record<string, unknown>;
    const candidate = rec.key ?? rec.path ?? rec.file ?? rec.name;
    if (typeof candidate !== "string" || !candidate.trim())
        return null;
    const trimmed = candidate.trim().replace(/^\//, "").replace(/^assets\//, "");
    const key = normalizeVaultKey(fallbackCategory && !trimmed.includes("/") ? `${fallbackCategory}/${trimmed}` : trimmed);
    const category = (typeof rec.category === "string" && rec.category)
        || fallbackCategory
        || (key.includes("/") ? key.slice(0, key.indexOf("/")) : undefined);
    return {
        ...rec,
        key,
        url: typeof rec.url === "string" && rec.url ? rec.url : urlFor(key),
        ...(category ? { category } : {}),
    };
}

export function collectManifestAssets(raw: VaultManifest, urlFor: (key: string) => string): VaultAssetEntry[] {
    const byKey = new Map<string, VaultAssetEntry>();
    if (Array.isArray(raw.assets)) {
        for (const item of raw.assets) {
            const entry = normalizeEntry(item, urlFor);
            if (entry)
                byKey.set(entry.key, entry);
        }
    }
    if (raw.categories && typeof raw.categories === "object" && !Array.isArray(raw.categories)) {
        for (const [cat, list] of Object.entries(raw.categories)) {
            if (!Array.isArray(list))
                continue;
            const cleanCat = cat.trim().replace(/^\/+|\/+$/g, "");
            for (const item of list) {
                const entry = normalizeEntry(item, urlFor, cleanCat || undefined);
                if (entry && !byKey.has(entry.key))
                    byKey.set(entry.key, entry);
            }
        }
    }
    return [...byKey.values()];
}
