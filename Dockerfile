FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=optional
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional
COPY --from=builder /app/dist ./dist
# Data directory (shards, indexes, manifest, state.json) is mounted read-only at runtime;
# the optional write path for self-updates is /app/data-writable.
CMD ["node", "dist/index.js"]
