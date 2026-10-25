FROM node:26.12.1-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./tsconfig.json
RUN npm run build

FROM node:26.12.1-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool pyosmium coreutils util-linux gawk ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY scripts ./scripts

# The active SQLite database is /osm/data/index.sqlite. Full rebuild baselines
# and update work are siblings under the same writable pipeline root (/osm).
VOLUME ["/osm"]
ENV OSM_AMENITY_DATA_DIR=/osm/data
EXPOSE 8081
CMD ["sh", "scripts/start-server.sh"]
