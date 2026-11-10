FROM oven/bun:1.3.14-alpine AS dashboard
WORKDIR /dashboard
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile
COPY app/ ./
RUN bun run build

FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile
COPY api/tsconfig*.json api/worker-configuration.d.ts ./
COPY api/src ./src
RUN bun run build

FROM oven/bun:1.3.14-alpine AS production-deps
WORKDIR /app
COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:24-alpine
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
