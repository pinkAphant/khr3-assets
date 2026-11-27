# `@khr3/assets`

Zero-dependency Cloudflare R2 `.glb` asset vault Worker ([src/worker.ts](./src/worker.ts)), CORS-enabled CDN client ([src/client.ts](./src/client.ts)), curated KHR/raw asset catalog ([src/catalog.ts](./src/catalog.ts)), and in-place binary `.glb` metric inspector/normalizer ([src/gate.ts](./src/gate.ts)) for `@khr3/*` and `Kolmo`.

- Full API & integration reference: [docs/api-reference.md](./docs/api-reference.md)
- Runnable example: [example/index.ts](./example/index.ts)
- Worker starter template: [template/worker.ts](./template/worker.ts) & [template/wrangler.jsonc](./template/wrangler.jsonc)

## Install

```sh
npm install @khr3/assets
```

## Export Subpaths

| Export Group | Subpath | Source | Exports | Purpose |
| --- | --- | --- | --- | --- |
| **Vault Client** | `@khr3/assets/client` (or root) | [src/client.ts](./src/client.ts) | `createAssetVault`, `resolveVaultBaseUrl`, `normalizeBaseUrl`, `DEFAULT_VAULT_URL`, `KOLMO_ASSETS_URL`, `normalizeVaultKey`, `normalizeVaultPrefix` | Fetch manifests, list/tree prefixes, resolve CORS `.glb` URLs (with `KHR3_VAULT_URL` / `VITE_KHR3_VAULT_URL` overrides and custom `fetch`), and perform authenticated `/admin/assets/*` writes |
| **Asset Catalog** | `@khr3/assets/catalog` (or root) | [src/catalog.ts](./src/catalog.ts) | `VAULT_CATALOG`, `VAULT_CARS`, `VAULT_WEAPONS`, `VAULT_CITY`, `VAULT_CAR_KEYS`, `VAULT_WEAPON_KEYS`, `VAULT_CITY_KEYS`, `createVaultCatalog`, `vaultAssetUrl` | Typed frozen URL maps for live R2 vehicles (including raw intake meshes like `crotch_rocket` / `starfox_rocket`), weapons (`pistol`, `smg`, `shotgun`, `rpg`), and C12 city props |
| **Cloudflare Worker** | `@khr3/assets/worker` (or root) | [src/worker.ts](./src/worker.ts) | `createVaultWorker` | Public read-only `/assets/*` CDN, `/api/tree`, and `/admin/*` gated by `VAULT_WRITE_TOKEN` or Cloudflare Access RS256 JWKS |
| **Binary `.glb` Normalizer** | `@khr3/assets/gate` (or root) | [src/gate.ts](./src/gate.ts) | `inspectGlbBuffer`, `normalizeGlbBuffer`, `quarterTurnsQuaternion` | Binary `.glb` bounds/wheelbase inspection, normal/winding baking, SI scaling, and `Y = 0` seating |
