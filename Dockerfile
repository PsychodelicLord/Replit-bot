FROM node:20-slim

RUN npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

RUN pnpm --filter @workspace/kalshi-bot run build

RUN ls artifacts/kalshi-bot/dist/public && cp -r artifacts/kalshi-bot/dist/public /app/public

EXPOSE 8080

CMD ["node", "artifacts/api-server/dist/index.mjs"]
