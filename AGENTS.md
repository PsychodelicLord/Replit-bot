## Cursor Cloud specific instructions

- Runtime service map (see `.replit` workflows): run `@workspace/api-server` on `:8080` and `@workspace/kalshi-bot` on `:19070` for the core product; `@workspace/mockup-sandbox` is optional.
- `DATABASE_URL` is mandatory at process start for the API (`lib/db/src/index.ts` throws immediately when missing), so provision DB connectivity before launching `@workspace/api-server`.
- Simulator mode still executes some Kalshi sync/signing paths on startup; if `KALSHI_PRIVATE_KEY` is missing or invalid, startup logs include OpenSSL decode warnings even while the API continues serving local endpoints.
- For standard commands, use package scripts in `package.json` and workflow commands in `.replit`; avoid duplicating one-off setup commands here.
- Current baseline: workspace root `pnpm run build` fails on existing `artifacts/api-server` TypeScript errors; use package-level builds (`@workspace/api-server`, `@workspace/kalshi-bot`) to validate runtime startup until those type errors are fixed.
