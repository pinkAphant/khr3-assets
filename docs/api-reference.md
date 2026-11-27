# `@khr3/assets` API and Configuration Guide

This guide documents all subpaths and exports for `@khr3/assets`: the R2 vault client, curated catalog, Cloudflare Worker, and headless binary `.glb` inspector/normalizer.

## Import Paths

```ts
import {
  DEFAULT_VAULT_URL,
  KOLMO_ASSETS_URL,
  VAULT_CAR_KEYS,
  VAULT_WEAPON_KEYS,
  VAULT_CITY_KEYS,
  VAULT_CARS,
  VAULT_WEAPONS,
  VAULT_CITY,
  VAULT_CATALOG,
  createVaultCatalog,
  vaultAssetUrl,
  createAssetVault,
  resolveVaultBaseUrl,
  normalizeBaseUrl,
  normalizeVaultKey,
  normalizeVaultPrefix,
  inspectGlbBuffer,
  normalizeGlbBuffer,
  quarterTurnsQuaternion,
  createVaultWorker,
} from "@khr3/assets";
import { createVaultWorker } from "@khr3/assets/worker";
import { VAULT_CARS, VAULT_WEAPONS, VAULT_CITY, VAULT_CATALOG, createVaultCatalog, vaultAssetUrl } from "@khr3/assets/catalog";
import { inspectGlbBuffer, normalizeGlbBuffer, quarterTurnsQuaternion } from "@khr3/assets/gate";
import { createAssetVault, resolveVaultBaseUrl, normalizeVaultKey, normalizeVaultPrefix } from "@khr3/assets/client";
```

## Subpaths

- `@khr3/assets`: re-exports `client`, `worker`, `catalog`, and `gate`
- `@khr3/assets/client`: `DEFAULT_VAULT_URL`, `KOLMO_ASSETS_URL`, `createAssetVault`, `resolveVaultBaseUrl`, `normalizeBaseUrl`, `normalizeVaultKey`, `normalizeVaultPrefix`, plus `AssetVaultClient`, `AssetVaultOptions`, `RenameAssetParams`, `VaultAssetEntry`, `VaultManifest`, `VaultTreeResponse`
- `@khr3/assets/catalog`: `VAULT_CAR_KEYS`, `VAULT_WEAPON_KEYS`, `VAULT_CITY_KEYS`, `VAULT_CARS`, `VAULT_WEAPONS`, `VAULT_CITY`, `VAULT_CATALOG`, `createVaultCatalog`, `vaultAssetUrl`, `VaultCarId`, `VaultWeaponId`, `VaultCityId`, `VaultCatalog`
- `@khr3/assets/worker`: `createVaultWorker`, plus `AssetsFetcher`, `JwksFetcher`, `R2BucketBinding`, `R2ListResult`, `R2ObjectMeta`, `R2ObjectWithBody`, `R2RangeInfo`, `VaultWorkerEnv`, `VaultWorkerOptions`
- `@khr3/assets/gate`: `inspectGlbBuffer`, `normalizeGlbBuffer`, `quarterTurnsQuaternion`, plus `GateAxis`, `GateInspectionResult`, `GateNormalizeOptions`, `GateNormalizedGlbResult`, `GateTurns`, `QuarterTurn`

## Vault Client (`@khr3/assets/client`)

- `DEFAULT_VAULT_URL`: `"https://khr3.optimuspi.workers.dev"` (primary live R2 vault)
- `KOLMO_ASSETS_URL`: `"https://kolmo-assets.pifreak.com"` (optional secondary override origin constant; currently serves 0 `.glb` objects)
- `normalizeBaseUrl(raw: string): string` — trims whitespace and trailing slashes, validates `http://` or `https://` protocol.
- `resolveVaultBaseUrl(overrideUrl?: string): string` — resolves vault origin checking `overrideUrl`, then `process.env.KHR3_VAULT_URL`, then `process.env.VAULT_URL`, then `import.meta.env.VITE_KHR3_VAULT_URL`, falling back to `DEFAULT_VAULT_URL`, normalized via `normalizeBaseUrl`.
- `normalizeVaultKey(key: string): string` — decodes up to 3 percent-encoding passes, strips leading `/` and `assets/`, rejects traversal (`..`), backslashes, control chars, empty segments, and trailing slashes.
- `normalizeVaultPrefix(prefix?: string): string` — normalizes folder prefix to `""` or `"folder/"` (rejecting traversal/control chars).
- `createAssetVault(baseUrlOrOpts?: string | AssetVaultOptions): AssetVaultClient`:
  - Accepts a base URL string or `{ baseUrl?: string; fetch?: typeof fetch }` (`AssetVaultOptions`), resolving `baseUrl` via `resolveVaultBaseUrl(...)` and defaulting `fetch` to `globalThis.fetch`.
  - `readonly baseUrl: string`
  - `url(key: string): string` — returns `${baseUrl}/assets/${normalizeVaultKey(key)}`
  - `manifest(init?: RequestInit): Promise<VaultManifest>` — fetches `/assets/manifest.json` and normalizes `assets` + `categories` entries
  - `list(category?: string, init?: RequestInit): Promise<VaultAssetEntry[]>` — filters manifest assets by category/prefix
  - `listPrefix(prefix?: string, init?: RequestInit): Promise<VaultTreeResponse>` — queries `GET /api/tree?prefix=...`
  - `fetchBytes(key: string, init?: RequestInit): Promise<ArrayBuffer>` — fetches binary asset bytes
  - `upload(key: string, bytes: ArrayBuffer | Uint8Array, token?: string): Promise<Response>` (alias `put`) — `PUT /admin/assets/<key>`
  - `deleteKey(key: string, token?: string): Promise<Response>` (alias `delete`) — `DELETE /admin/assets/<key>`
  - `renameKey(params: RenameAssetParams, token?: string): Promise<Response>` — `POST /admin/rename` with `{ from, to, overwrite }`
  - `createFolder(prefix: string, token?: string): Promise<Response>` — `POST /admin/folders` with `{ prefix }`

### Client Types

- `AssetVaultOptions`: `{ readonly baseUrl?: string; readonly fetch?: typeof fetch }`
- `VaultAssetEntry`: `{ key: string; url?: string; size?: number; etag?: string; uploaded?: string; contentType?: string; category?: string; [k: string]: unknown }`
- `VaultManifest`: `{ baseUrl?: string; count?: number; assets: VaultAssetEntry[]; categories?: Record<string, Array<string | VaultAssetEntry>>; [k: string]: unknown }`
- `VaultTreeResponse`: `{ prefix: string; folders: string[]; items: VaultAssetEntry[] }`
- `RenameAssetParams`: `{ from: string; to: string; overwrite?: boolean }`

## Curated Catalog (`@khr3/assets/catalog`)

- `VAULT_CARS` (`VaultCarId`):
  - `kolmogorov_hatchback` -> `cars/kolmogorov_hatchback.glb`
  - `lexus_is300` -> `cars/lexus_is300.glb`
  - `nissan_silvia_s15` -> `cars/nissan_silvia_s15.glb`
  - `nissan_skyline_r34` -> `cars/nissan_skyline_r34.glb`
  - `toyota_supra_a80` -> `cars/toyota_supra_a80.glb`
  - `crotch_rocket` -> `cars/crotch_rocket.glb` (raw intake mesh; calibrate via `<GlbImportGate>` or `normalizeGlbBuffer`)
  - `starfox_rocket` -> `cars/starfox_rocket.glb` (raw intake mesh; calibrate via `<GlbImportGate>` or `normalizeGlbBuffer`)
- `VAULT_WEAPONS` (`VaultWeaponId`, `VAULT_WEAPON_KEYS`):
  - `pistol`, `kolmogorov_pistol` -> `weapons/kolmogorov_pistol.glb`
  - `smg`, `kolmogorov_smg` -> `weapons/kolmogorov_smg.glb`
  - `shotgun`, `kolmogorov_shotgun` -> `weapons/kolmogorov_shotgun.glb`
  - `rpg`, `kolmogorov_rpg` -> `weapons/kolmogorov_rpg.glb`
- `VAULT_CITY` (`VaultCityId`, `VAULT_CITY_KEYS`):
  - `road_straight`, `road_crosswalk`, `road_intersection`, `curb_straight`, `curb_ramp`, `curb_driveway`, `light_pole`, `gas_canopy`, `gas_pump_twin`, `neon_petro_sign`, `door_hinged_single`, `roof_gable_3x3`, `prop_arcade_cabinet` (all under `city/`)
- `VAULT_CATALOG`: `{ cars: VAULT_CARS, weapons: VAULT_WEAPONS, city: VAULT_CITY }`
- `createVaultCatalog(baseUrl = resolveVaultBaseUrl()): VaultCatalog` — builds a frozen `{ cars, weapons, city }` URL map targeting a custom or env-configured vault origin.
- `vaultAssetUrl(key: string, baseUrl = resolveVaultBaseUrl()): string`

## Binary `.glb` Gate (`@khr3/assets/gate`)

- `QuarterTurn`: `0 | 1 | 2 | 3`
- `GateTurns`: `readonly [QuarterTurn, QuarterTurn, QuarterTurn]`
- `GateAxis`: `"maxSpan" | "widthX" | "heightY" | "lengthZ" | "wheelbase"`
- `GateNormalizeOptions`: `{ readonly targetMeters: number; readonly axis?: GateAxis; readonly turns?: GateTurns }`
- `GateInspectionResult`: `{ readonly min: [number, number, number]; readonly max: [number, number, number]; readonly sizeMeters: [number, number, number]; readonly wheelbaseMeters: number | null; readonly nodeCount: number; readonly meshCount: number; readonly extensionsUsed: string[] }`
- `GateNormalizedGlbResult`: `GateInspectionResult & { readonly glb: ArrayBuffer; readonly scaleApplied: number }`
- `quarterTurnsQuaternion(turns: GateTurns): [number, number, number, number]`
- `inspectGlbBuffer(source, turns = [0, 0, 0]) => GateInspectionResult`:
  - Validates GLB v2 header, rejects `KHR_draco_mesh_compression` / `EXT_meshopt_compression` and cyclic/shared node graphs.
  - Computes world-space AABB (`min`, `max`, `sizeMeters`) and `wheelbaseMeters` by detecting wheel nodes matching `/wheel|tire|rim|tyre/i`, `extras.ecctrlWheel`, or `extensions.OMI_vehicle_wheel.wheel` (validated against root `extensions.OMI_vehicle_wheel.wheels` when present). Supports both mesh-bearing wheel nodes and meshless explicit wheel mount nodes (`OMI_vehicle_wheel` / `extras.ecctrlWheel`), while ignoring meshless container groups without wheel metadata.
- `normalizeGlbBuffer(source, { targetMeters, axis = "maxSpan", turns = [0, 0, 0] }) => GateNormalizedGlbResult`:
  - Validates `targetMeters` is a finite positive number (throws `Error` on `<= 0`, `NaN`, or `Infinity`).
  - Uniformly scales to `targetMeters` along `axis`, centers XZ at `(0, 0)`, seats `min.y` on `Y = 0`, and scales `OMI_vehicle_wheel.wheels[]` (`radius`, `width`, `suspensionTravel`) + `extras.ecctrlWheel` (`radius`, `width`, `travel`, `sag`).
  - **Hierarchical `KHR_physics_rigid_bodies` preservation**: When `KHR_physics_rigid_bodies` is detected, preserves all `node.children` and `scenes[scene].nodes`, keeps node `scale` omitted (`[1, 1, 1]`), rejects negative/non-uniform scale on physics/parent nodes, shifts/rotates root nodes by `turns` + centering offset, scales child translations and mesh vertices, and scales `KHR_implicit_shapes.shapes[]`, `motion.centerOfMass` (`* s`), `motion.inertiaDiagonal` (`* s^2`), and linear `physicsJoints` `limits` / `drives` (`* s`).
  - **Non-KHR GLBs**: Bakes world transforms into mesh vertices, transforms normals by $(M^{-1})^T$, flips winding when $\det(M) < 0$, preserves empty socket nodes, clones shared mesh accessors, and scales wheel metadata.

## Cloudflare Worker (`@khr3/assets/worker`)

- `createVaultWorker(options?: VaultWorkerOptions): { fetch(req: Request, env: VaultWorkerEnv): Promise<Response> }`:
  - `GET`/`HEAD`/`OPTIONS` under `options.prefix` (default `"/assets/"`): serves R2 objects with CORS headers, `ETag` (`If-None-Match` -> `304`), `Accept-Ranges: bytes`, and `Range` (`206` / `416`).
  - `GET /api/tree?prefix=...`: paginated R2 delimiter listing filtering out `/.keep` markers.
  - `/admin/assets/*` (`GET`, `HEAD`, `PUT`, `DELETE`), `POST /admin/folders`, `POST /admin/rename`: authorized via `Authorization: Bearer <VAULT_WRITE_TOKEN>` (constant-time SHA-256 digest check) or `Cf-Access-Jwt-Assertion` RS256 JWKS verification. `PUT /admin/assets/*` enforces strict digit-only `Content-Length` headers (`400`/`413`) and maps `FixedLengthStream` byte-count mismatches to `400` (`413` when exceeding `maxUploadBytes`), reserving `500` throws for R2 storage I/O failures. `/admin/rename` wraps `src.body` with `FixedLengthStream(src.size)` when available (with buffer fallback).
- Worker Types: `R2RangeInfo`, `R2ObjectMeta`, `R2ObjectWithBody`, `R2ListResult`, `R2BucketBinding`, `AssetsFetcher`, `VaultWorkerEnv`, `VaultWorkerOptions` (`{ prefix?: string; maxUploadBytes?: number; jwksTtlMs?: number; jwksFetcher?: JwksFetcher }`), `JwksFetcher`.
