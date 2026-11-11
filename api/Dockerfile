FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS bun

FROM bun AS dashboard
WORKDIR /dashboard
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile
COPY app/ ./
RUN bun run build

FROM bun AS build
WORKDIR /app
COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile
COPY api/tsconfig*.json api/worker-configuration.d.ts ./
COPY api/src ./src
RUN bun run build

FROM bun AS production-deps
WORKDIR /app
COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY api/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=dashboard /dashboard/dist ./public
COPY api/migrations ./migrations
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
