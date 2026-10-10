# Same image for the API and the worker: WORKER_ROLE decides which one starts queue processors.
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Production dependencies only (no reinstall). Includes the bundled ffmpeg binary.
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Demo seed media, used only when SEED_DEMO_CONTENT=true on a non-production environment.
COPY assets ./assets

# Media goes to object storage, so the only local writes are temp files under /tmp.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/health/live || exit 1

CMD ["node", "dist/main.js"]
