# Workspace

## Overview

Kalshi Scalping Bot — automatically scans 15-minute Kalshi prediction markets and scalps small price differences (5–25 cents) all day. Max bet per trade: $0.59. Skips any market with 10 minutes or less remaining.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite (dark trading terminal theme)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server + Kalshi bot engine
│   └── kalshi-bot/         # React dashboard (dark terminal UI)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
```

## Bot Logic (artifacts/api-server/src/lib/kalshi-bot.ts)

- Scans Kalshi open markets every 20 seconds
- Filters for markets with 10–16 minutes remaining (15-min markets, but skips any with ≤10 min left)
- Looks for YES/NO bid-ask spreads between 5–25 cents
- Calculates net profit after Kalshi's 7% fee on winnings
- Only enters a trade if net profit > 0
- Max bet: $0.59 per trade (as many contracts as that covers at the ask price)
- Places limit buy orders via Kalshi REST API with RSA-signed requests
- Attempts to sell at the bid price after 3 seconds to capture the spread
- Retries selling open positions every 8 seconds
- Marks positions as expired (full loss) if open for 12+ minutes

## API Endpoints

- `GET /api/bot/status` — bot running state + stats
- `POST /api/bot/start` — start the bot
- `POST /api/bot/stop` — stop the bot
- `GET /api/trades` — trade history (paginated)
- `GET /api/trades/stats` — win rate, P&L, totals
- `GET /api/logs` — recent bot activity logs

## Secrets Required

- `KALSHI_API_KEY` — Kalshi API key ID
- `KALSHI_PRIVATE_KEY` — RSA private key PEM (newlines as `\n`)

## Database Tables

- `trades` — all trade records with buy/sell prices, P&L, status
- `bot_logs` — timestamped bot activity log

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references
- `pnpm --filter @workspace/db run push` — push DB schema changes
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API types from OpenAPI spec
