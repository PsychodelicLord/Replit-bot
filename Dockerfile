FROM node:24-slim

RUN npm install -g pnpm

WORKDIR /app

COPY . .

# Install full workspace so frontend+backend builds always use current source.
# Railway occasionally enforces strict dep-build approval; pass an explicit allowlist
# so esbuild/@swc build scripts run non-interactively in CI containers.
RUN pnpm install --no-frozen-lockfile --config.only-built-dependencies=esbuild,@swc/core,msw,unrs-resolver --config.strict-dep-builds=true

RUN rm -rf artifacts/kalshi-bot/dist/public
RUN pnpm --filter @workspace/kalshi-bot run build
RUN pnpm --filter @workspace/api-server run build

EXPOSE 8080

CMD ["node", "artifacts/api-server/dist/index.mjs"]
