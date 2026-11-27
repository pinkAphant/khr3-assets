# `@khr3/assets` (`khr3-assets`) — Agent & Contributor Guide

- **Zero Runtime Dependencies**: Keep `@khr3/assets` (`@khr3/assets` client & `@khr3/assets/worker` Cloudflare R2 vault handler) zero-dependency ESM TypeScript with `.d.ts` declarations and sourcemaps.
- **R2 Vault & Catalog Contract**: Maintain `VAULT_BASE_URL` (`https://khr3.optimuspi.workers.dev`), typed shelf catalogs, CORS-enabled binary `.glb` streaming, and authenticated R2 write routes.
- **Module Hygiene & Verification**: Keep every file in `src/` `<= 250` lines, keep [README.md](./README.md) and [docs/api-reference.md](./docs/api-reference.md) aligned with exports, and verify with `npm run typecheck && npm test && npm run build`.
