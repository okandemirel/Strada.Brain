# =============================================================================
# Strada.Brain - Production Dockerfile
# =============================================================================
# Multi-stage build with security hardening:
#   - Stage 1: Builder (compile TypeScript)
#   - Stage 2: Production (runtime only)
#
# Build:
#   docker build -t strada-brain:latest .
#
# Run:
#   docker run -d --name strada-brain \
#     -p 3100:3100 -p 9090:9090 \
#     -v $(pwd)/project:/app/project:ro \
#     -v strada-home:/app/.strada \
#     -v strada-memory:/app/.strada-memory \
#     strada-brain:latest
# =============================================================================

# =============================================================================
# STAGE 1: Builder
# =============================================================================
FROM node:22.12-alpine AS builder

# Build arguments
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    libc-dev \
    linux-headers

# Set working directory
WORKDIR /app

# Copy package files first (for better layer caching)
COPY package*.json ./
COPY tsconfig.json ./

# scripts/ BEFORE the install, not after it: npm runs the root package's
# `prepare` lifecycle script as part of `npm ci`, and `prepare` is
# `node scripts/install-git-hooks.mjs`. With scripts/ copied afterwards the
# install itself died on a missing module and no image was ever produced
# (round 10 #20). The script is a no-op without .git/hooks — which is the case
# here — but it has to exist to be a no-op.
COPY scripts/ ./scripts/

# Install all dependencies (including devDependencies for build)
RUN npm ci --include=dev && \
    npm cache clean --force

# Portal dependencies come from its own lockfile. node_modules is
# .dockerignore'd, so the portal has none in the image until they are installed
# here — and a failed portal build is deliberately fatal to `npm run build`.
#
# --include=dev is load-bearing: NODE_ENV=production (the ARG default above)
# makes npm omit devDependencies, and the portal's build IS `tsc -b && vite
# build` — both devDependencies of web-portal/package.json. Without it the
# portal install succeeded and the portal BUILD failed (round 10 #20).
COPY web-portal/package.json web-portal/package-lock.json ./web-portal/
RUN npm ci --prefix web-portal --include=dev && \
    npm cache clean --force

# Copy the rest of the sources. `npm run build` IS
# `node scripts/build-package.mjs`, and that script builds web-portal/ and
# copies its output into dist/channels/web/static — so both directories must be
# in the build context of this stage, not just src/.
COPY web-portal/ ./web-portal/
COPY src/ ./src/

# Build TypeScript + web portal
RUN npm run build

# Prune devDependencies for production
RUN npm prune --omit=dev && \
    npm cache clean --force

# =============================================================================
# STAGE 2: Production
# =============================================================================
FROM node:22.12-alpine AS production

# Labels
LABEL org.opencontainers.image.title="Strada.Brain" \
      org.opencontainers.image.description="AI-powered Unity development assistant" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.vendor="Strada" \
      org.opencontainers.image.source="https://github.com/okandemirel/Strada.Brain"

# Install runtime dependencies
RUN apk add --no-cache \
    dumb-init \
    wget \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Runtime user: the base image's own `node` account (uid/gid 1000). Creating a
# second uid/gid-1000 account here fails the build ("gid '1000' in use").

# Set working directory
WORKDIR /app

# Create required directories with proper permissions. /app/.strada is the
# config root (STRADA_HOME below); it must exist and belong to the runtime user
# so a named volume mounted there starts out writable (OPS-3).
RUN mkdir -p \
    /app/.strada \
    /app/.strada-memory \
    /app/logs \
    /app/plugins \
    /app/project \
    /tmp && \
    chown -R node:node /app && \
    chmod 755 /app

# Copy production dependencies from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy built application from builder
COPY --from=builder --chown=node:node /app/dist ./dist

# Ops and runtime scripts (backup, launcher, boot smoke). `npm run <script>`
# inside the container resolves to these; without them every package script is
# a "file not found". The portal's SOURCES are not copied — its built bundle
# already lives in dist/channels/web/static.
COPY --from=builder --chown=node:node /app/scripts ./scripts

# Copy package files
COPY --from=builder --chown=node:node /app/package*.json ./

# Switch to non-root user
USER node

# Environment variables
#
# STRADA_HOME is where an install without a .git checkout keeps its config root:
# .env, the trust/owner databases and runtime state; startup creates it
# before anything else runs. The compose files run with a read-only root
# filesystem and mount a volume here; with plain `docker run`, mount one too
# (-v strada-home:/app/.strada) or it is lost when the container is re-created.
# It is also $HOME/.strada, which some subsystems still address directly.
ENV NODE_ENV=production \
    HOME=/app \
    STRADA_HOME=/app/.strada \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    DASHBOARD_PORT=3100 \
    METRICS_PORT=9090 \
    HEALTH_CHECK_PORT=3100

# Expose ports
# 3100 - Dashboard UI
# 9090 - Prometheus metrics
EXPOSE 3100 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --start-interval=5s --retries=3 \
    CMD wget -q --spider http://localhost:3100/health || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Default command
CMD ["node", "dist/index.js", "start", "--channel", "web"]

# =============================================================================
# STAGE 3: Development (optional)
# =============================================================================
FROM builder AS development

# Install additional dev tools
RUN apk add --no-cache git

# Set environment
ENV NODE_ENV=development \
    DASHBOARD_PORT=3100 \
    METRICS_PORT=9090

# Expose ports
EXPOSE 3100 9090

# Run in dev mode with hot reload
CMD ["npm", "run", "dev"]
