# Workspace

## Overview

Kalshi Instinct Scalper — automated 24/7 momentum-based trading bot for Kalshi 15-minute crypto prediction markets (BTC/ETH/SOL/DOGE/XRP/BNB/HYPE). Detects directional price momentum and scalps 3¢ TP / 4¢ SL. Has a sim mode for risk-free testing with real market data.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM (Neon on Railway, local on Replit)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite (dark trading terminal theme)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server + Kalshi momentum bot engine
│   └── kalshi-bot/         # React dashboard (dark terminal UI)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
├── push.sh                 # Push to Railway via GitHub
```

## Momentum Bot Logic (artifacts/api-server/src/lib/momentumBot.ts)

### Core Strategy
- Scans 7 crypto markets every 15 seconds
- Tracks price movement direction per market tick
- **Directional-only tick window**: only actual ¢ price moves count — flat scans don't consume slots, so signals persist until the market actually moves again
- In sim mode: needs 2 directional ticks same direction; live: needs 3
- TP = 3¢, SL = 4¢, Stale exit = 45s, Cooldown = 75s per market
- Max 2 concurrent positions

### Signal Filters
- `priceMin/priceMax`: scan-level filter (default 5-95¢ in sim, 20-80¢ live)
- `ENTRY_BUFFER_CENTS=5`: allows momentum tracking ±5¢ outside range
- **Entry-time price guard**: blocks BUY_NO if mid < priceMin (NO already maxed out), and BUY_YES if mid > priceMax
- Spread filter: sim ≤8¢ scan / ≤5¢ entry; live ≤5¢ scan / ≤3¢ entry
- `MIN_TOTAL_MOVE_CENTS`: 1¢ sim / 2¢ live total move before allowing entry
- `MIN_MINUTES_REMAINING`: 2 min sim / 3 min live
- `MOMENTUM_EXPIRY_MS=120_000`: reset window if no directional tick for 2 minutes

### Key Files
- `artifacts/api-server/src/lib/momentumBot.ts` — core bot engine
- `artifacts/api-server/src/routes/bot.ts` — REST endpoints
- `artifacts/kalshi-bot/src/components/momentum-bot.tsx` — React dashboard

## API Endpoints

- `GET /api/bot/momentum/status` — bot state + sim stats
- `POST /api/bot/momentum/auto` — start/configure bot (simulatorMode, betCostCents, priceMin/Max, etc.)
- `POST /api/bot/momentum/stop` — stop bot
- `GET /api/bot/momentum/debug` — live market data + momentum counters + all positions
- `GET /api/bot/momentum/config` — current config
- `PATCH /api/bot/momentum/config` — update config live

## Secrets Required

- `KALSHI_API_KEY` — Kalshi API key ID
- `KALSHI_PRIVATE_KEY` — RSA private key PEM (newlines as `\n`)
- `SESSION_SECRET` — Express session secret
- `DATABASE_URL` — PostgreSQL connection string (Neon on Railway)

## Database Tables (lib/db/src/schema/)

- `momentum_settings` — persisted bot config (enabled, simulatorMode, priceMin/Max, etc.)
- `trades` — trade history
- `bot_logs` — timestamped activity log

## Railway Deployment

- Bot auto-starts via `MOMENTUM_AUTO_START=true` env var (reads config from DB)
- Railway uses Neon DB; Replit uses local PostgreSQL
- `loadMomentumConfig` retries up to 10 times (progressive delay ~81s) to handle Neon cold starts
- Deploy: run `./push.sh` to push HEAD to GitHub → Railway picks up and deploys

## Root Scripts

- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/kalshi-bot run build` — build frontend (required before Railway deploy)
- `pnpm --filter @workspace/db run push` — push DB schema changes
