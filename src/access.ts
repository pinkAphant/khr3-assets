export type JwksFetcher = (certsUrl: string) => Promise<{ keys?: JsonWebKey[] }>;

export interface AccessAuthEnv {
    VAULT_WRITE_TOKEN?: string;
    CF_ACCESS_AUD?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_CERTS_JSON?: string;
}

export interface AccessVerifierOptions {
    jwksTtlMs?: number;
    jwksFetcher?: JwksFetcher;
}

const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000;
const MAX_KEY_CACHE_SIZE = 64;

export function normalizeTeamIssuer(raw?: string): string | null {
    if (!raw)
        return null;
    let host = raw.trim().replace(/\/+$/, "").replace(/^https?:\/\//i, "").toLowerCase();
    if (!host || /[/?#@\s\\]/.test(host) || !/^[a-z0-9.-]+$/.test(host))
        return null;
    if (!host.includes("."))
        host = `${host}.cloudflareaccess.com`;
    return `https://${host}`;
}

function decodeBase64Url(segment: string): Uint8Array<ArrayBuffer> | null {
    if (!segment || segment.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
        return null;
    }
    const padLen = (4 - (segment.length % 4)) % 4;
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
    try {
        const bin = atob(b64);
        const out = new Uint8Array(new ArrayBuffer(bin.length));
        for (let i = 0; i < bin.length; i++)
            out[i] = bin.charCodeAt(i);
        return out;
    }
    catch {
        return null;
    }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
    const bytes = decodeBase64Url(segment);
    if (!bytes)
        return null;
    try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return null;
        return parsed as Record<string, unknown>;
    }
    catch {
        return null;
    }
}

function xorBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength)
        return false;
    let diff = 0;
    for (let i = 0; i < a.byteLength; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}

type SubtleWithTimingSafe = SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
};

export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
    const enc = new TextEncoder();
    const aBytes = enc.encode(a);
    const bBytes = enc.encode(b);
    const [hashA, hashB] = await Promise.all([
        crypto.subtle.digest("SHA-256", aBytes),
        crypto.subtle.digest("SHA-256", bBytes),
    ]);
    const subtle = crypto.subtle as SubtleWithTimingSafe;
    const digestsMatch = typeof subtle.timingSafeEqual === "function"
        ? subtle.timingSafeEqual(hashA, hashB)
        : xorBytesEqual(new Uint8Array(hashA), new Uint8Array(hashB));
    return digestsMatch && aBytes.byteLength === bBytes.byteLength;
}

const defaultJwksFetcher: JwksFetcher = async (certsUrl) => {
    const res = await fetch(certsUrl);
    if (!res.ok)
        throw new Error(`HTTP ${res.status} fetching JWKS`);
    return (await res.json()) as { keys?: JsonWebKey[] };
};

export function createAccessAuthorizer(options?: AccessVerifierOptions): {
    verifyAccessJwt: (token: string, env: AccessAuthEnv) => Promise<{ ok: true } | { ok: false; status: 401 | 403 }>;
    checkWriteAuth: (req: Request, env: AccessAuthEnv, corsHeaders: Record<string, string>) => Promise<Response | null>;
} {
    const ttlMs = options?.jwksTtlMs ?? DEFAULT_JWKS_TTL_MS;
    const fetchJwks = options?.jwksFetcher ?? defaultJwksFetcher;
    const keyCache = new Map<string, { key: CryptoKey; expiresAt: number }>();
    const jwksCache = new Map<string, { keys: JsonWebKey[]; expiresAt: number; fetchedAt: number }>();

    async function resolveKey(kid: string, issuer: string, certsJson?: string): Promise<CryptoKey | null> {
        const now = Date.now();
        const sourceKey = certsJson ? `inline:${certsJson}` : issuer;
        const cacheId = `${sourceKey}:${kid}`;
        const cached = keyCache.get(cacheId);
        if (cached && now < cached.expiresAt)
            return cached.key;
        let keys: JsonWebKey[] | undefined;
        if (certsJson) {
            const parsed = JSON.parse(certsJson) as { keys?: JsonWebKey[] };
            keys = parsed.keys;
        }
        else {
            let jwksEntry = jwksCache.get(issuer);
            const hasKid = jwksEntry?.keys.some((k) => (k as Record<string, unknown>).kid === kid);
            if (!jwksEntry || now >= jwksEntry.expiresAt || (!hasKid && now - jwksEntry.fetchedAt >= 10_000)) {
                const fetched = await fetchJwks(`${issuer}/cdn-cgi/access/certs`);
                jwksEntry = { keys: Array.isArray(fetched.keys) ? fetched.keys : [], expiresAt: now + ttlMs, fetchedAt: now };
                jwksCache.set(issuer, jwksEntry);
            }
            keys = jwksEntry.keys;
        }
        const jwk = (keys ?? []).find((k) => {
            const rec = k as Record<string, unknown>;
            if (rec.kid !== kid || rec.kty !== "RSA")
                return false;
            if (rec.alg && rec.alg !== "RS256")
                return false;
            if (rec.use && rec.use !== "sig")
                return false;
            return typeof rec.n === "string" && typeof rec.e === "string";
        });
        if (!jwk)
            return null;
        const imported = await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
        );
        if (keyCache.size >= MAX_KEY_CACHE_SIZE) {
            const oldest = keyCache.keys().next().value;
            if (oldest !== undefined)
                keyCache.delete(oldest);
        }
        keyCache.set(cacheId, { key: imported, expiresAt: now + ttlMs });
        return imported;
    }

    async function verifyAccessJwt(token: string, env: AccessAuthEnv): Promise<{ ok: true } | { ok: false; status: 401 | 403 }> {
        if (!token || token.length > 16_384 || !env.CF_ACCESS_AUD)
            return { ok: false, status: 401 };
        const issuer = normalizeTeamIssuer(env.CF_ACCESS_TEAM_DOMAIN);
        if (!issuer)
            return { ok: false, status: 401 };
        const parts = token.split(".");
        if (parts.length !== 3)
            return { ok: false, status: 401 };
        const [headerB64, payloadB64, sigB64] = parts;
        const header = decodeJsonSegment(headerB64);
        const payload = decodeJsonSegment(payloadB64);
        const sigBytes = decodeBase64Url(sigB64);
        if (!header || !payload || !sigBytes)
            return { ok: false, status: 401 };
        if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 256) {
            return { ok: false, status: 401 };
        }
        const tokenIss = typeof payload.iss === "string" ? payload.iss.replace(/\/$/, "") : "";
        if (tokenIss !== issuer)
            return { ok: false, status: 403 };
        const aud = payload.aud;
        const audOk = typeof aud === "string"
            ? aud === env.CF_ACCESS_AUD
            : Array.isArray(aud) && aud.some((a) => typeof a === "string" && a === env.CF_ACCESS_AUD);
        if (!audOk)
            return { ok: false, status: 403 };
        const nowSec = Math.floor(Date.now() / 1000);
        if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
            return { ok: false, status: 401 };
        }
        if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > nowSec)) {
            return { ok: false, status: 401 };
        }
        try {
            const pubKey = await resolveKey(header.kid, issuer, env.CF_ACCESS_CERTS_JSON);
            if (!pubKey)
                return { ok: false, status: 401 };
            const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
            const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pubKey, sigBytes, signedInput);
            return valid ? { ok: true } : { ok: false, status: 401 };
        }
        catch {
            return { ok: false, status: 401 };
        }
    }

    async function checkWriteAuth(req: Request, env: AccessAuthEnv, corsHeaders: Record<string, string>): Promise<Response | null> {
        const hasToken = Boolean(env.VAULT_WRITE_TOKEN);
        const hasAccess = Boolean(env.CF_ACCESS_AUD && normalizeTeamIssuer(env.CF_ACCESS_TEAM_DOMAIN));
        if (!hasToken && !hasAccess) {
            return Response.json(
                { error: "Vault writes are disabled (VAULT_WRITE_TOKEN or CF_ACCESS_AUD + CF_ACCESS_TEAM_DOMAIN not configured)" },
                { status: 503, headers: corsHeaders },
            );
        }
        const authHeader = req.headers.get("authorization");
        if (hasToken && authHeader !== null) {
            if (await timingSafeEqualStrings(authHeader, `Bearer ${env.VAULT_WRITE_TOKEN}`)) {
                return null;
            }
        }
        const cfJwt = req.headers.get("cf-access-jwt-assertion");
        if (hasAccess && cfJwt !== null) {
            const verified = await verifyAccessJwt(cfJwt, env);
            if (verified.ok)
                return null;
            const status: number = verified.status;
            return Response.json({ error: "Invalid Cloudflare Access JWT" }, { status, headers: corsHeaders });
        }
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    return { verifyAccessJwt, checkWriteAuth };
}
