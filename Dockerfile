FROM node:20-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY . .

# Install full workspace so frontend+backend builds always use current source.
RUN pnpm install --no-frozen-lockfile

RUN rm -rf artifacts/kalshi-bot/dist/public
RUN pnpm --filter @workspace/kalshi-bot run build
RUN pnpm --filter @workspace/api-server run build

EXPOSE 8080

CMD ["node", "artifacts/api-server/dist/index.mjs"]
