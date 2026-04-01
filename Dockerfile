FROM node:20-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

EXPOSE 3000

ENV PORT=3000

CMD pnpm --filter @workspace/db run push-force && node artifacts/api-server/dist/index.mjs
