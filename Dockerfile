FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./tsconfig.json
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool coreutils util-linux gawk ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY scripts ./scripts

# The active generation is /osm/data; updater staging and immutable generations
# are siblings under the same writable pipeline root (/osm).
VOLUME ["/osm"]
ENV OSM_AMENITY_DATA_DIR=/osm/data
EXPOSE 8081
CMD ["node", "dist/index.js"]
