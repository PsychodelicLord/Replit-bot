FROM node:20-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile --filter @workspace/api-server...

RUN pnpm --filter @workspace/api-server run build

RUN cp -r artifacts/kalshi-bot/dist/public artifacts/api-server/dist/public

EXPOSE 8080

CMD ["node", "artifacts/api-server/dist/index.mjs"]
