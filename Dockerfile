FROM node:20-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

RUN pnpm --filter @workspace/kalshi-bot run build

EXPOSE 8080

CMD ["sh", "-c", "pnpm --filter @workspace/db run push-force; node artifacts/api-server/dist/index.mjs"]
