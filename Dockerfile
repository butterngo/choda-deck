# syntax=docker/dockerfile:1.7
# ============================================================================
# choda-deck — multi-stage Dockerfile for MCP HTTP server in K8s.
#
# Stage 1 (builder): install ALL deps + build esbuild bundles + prune dev deps.
# Stage 2 (runtime): slim base + tini + non-root user; copies built artifacts.
#
# Skips `optionalDependencies` (@huggingface/transformers, onnxruntime-node, sharp)
# — these are NOT installed in the image. Code must handle their absence; if a
# tool path requires them, install separately or change them to regular deps.
#
# Build & run locally:
#   docker build -t choda-deck:dev .
#   docker run --rm -p 7337:7337 \
#     -e MCP_HTTP_TOKEN=devtoken \
#     -v $(pwd)/.data:/data \
#     choda-deck:dev
#   curl -H "Authorization: Bearer devtoken" http://localhost:7337/<endpoint>
# ============================================================================

# ---------- Stage 1: builder ----------
FROM node:22-bookworm-slim AS builder

# Build deps for better-sqlite3 / sqlite-vec native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack — version pinned by package.json `packageManager`
RUN corepack enable

WORKDIR /app

# Manifests first for layer cache
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install ALL deps (dev needed for esbuild build step).
# --shamefully-hoist flattens pnpm symlinks → standard node_modules tree that
# copies cleanly across stages.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --shamefully-hoist

# Source + build configs
COPY tsconfig.json tsconfig.node.json ./
COPY src ./src

# Build esbuild bundles → dist/cli.cjs + dist/mcp-server.cjs + dist/mcp-rules.md
RUN pnpm run build

# Strip dev deps THEN drop heavy optionalDependencies (~650MB).
# NOTE: order matters — `pnpm prune` reinstalls anything still in the lockfile
# (including optionals), so the `rm -rf` MUST come AFTER prune.
# If any tool path needs onnxruntime/sharp/transformers at runtime, move them
# from optionalDependencies → dependencies and update this list.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm prune --prod \
 && rm -rf \
    node_modules/.pnpm/onnxruntime-* \
    node_modules/.pnpm/@huggingface* \
    node_modules/.pnpm/@img* \
    node_modules/.pnpm/sharp* \
    node_modules/.pnpm/protobufjs* \
    node_modules/onnxruntime-node \
    node_modules/onnxruntime-web \
    node_modules/onnxruntime-common \
    node_modules/@huggingface \
    node_modules/@img \
    node_modules/sharp \
    node_modules/protobufjs

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime

# tini for proper SIGTERM propagation (Node as PID 1 misses signals otherwise)
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Use the pre-existing `node` user (uid 1000, gid 1000) shipped with node:*-slim.
# Matches K8s pod securityContext { runAsUser: 1000, fsGroup: 1000 }.

WORKDIR /app

# Copy built artifacts + pruned node_modules from builder
COPY --from=builder --chown=node:node /app/dist          ./dist
COPY --from=builder --chown=node:node /app/node_modules  ./node_modules
COPY --from=builder --chown=node:node /app/package.json  ./package.json

# /data is the PVC mount point — SQLite DB + WAL/SHM + artifacts + backups live here.
# Container creates it; K8s fsGroup chowns the mounted PVC to gid 1000 at mount time.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

ENV NODE_ENV=production \
    CHODA_DATA_DIR=/data \
    MCP_TRANSPORT=http \
    MCP_HTTP_PORT=7337 \
    MCP_HTTP_BIND=0.0.0.0
# NOTE: MCP_HTTP_TOKEN is intentionally NOT set here — provide via K8s Secret.

EXPOSE 7337

# tini reaps zombies and forwards SIGTERM to node for graceful shutdown
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli.cjs", "mcp", "serve"]
