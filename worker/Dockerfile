# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Poster_Worker container image (Requirements 6.1, 6.2, 6.5)
#
# This is the separate, long-running worker service deployed to Railway. It is
# NOT part of the Vercel serverless request path (Req 6.2). The image must:
#   - run on a Node runtime matching the worker's engines (node >= 20.20.0),
#     so we pin a Node 20 base image (Debian "bookworm") whose glibc/libvips
#     support ships prebuilt `sharp` binaries without extra build tooling.
#   - build the TypeScript worker with `tsc` (npm run build -> dist/).
#   - provide the `ffmpeg` binary AT RUNTIME so frame extraction works in the
#     deployed container (Req 6.5, 8.1). ffmpeg is installed via apt-get in the
#     FINAL stage so it is present in the image that actually runs.
#   - start the long-running poll loop with `node dist/index.js` (Req 6.4).
#
# A multi-stage build keeps the final image lean: the builder stage compiles
# with full devDependencies, and the runtime stage carries only production
# dependencies plus the compiled dist/ and the ffmpeg binary.
# ---------------------------------------------------------------------------

# --- Stage 1: build -------------------------------------------------------
# Compile TypeScript -> dist/ using the full dependency set (incl. typescript).
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install dependencies first for better layer caching. Copy only the manifests
# so `npm ci` is not invalidated by unrelated source changes.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the worker sources and build config, then compile to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production-only dependencies so they can be copied into the runtime
# stage without the build-time devDependencies (typescript, vitest, etc.).
RUN npm prune --omit=dev

# --- Stage 2: runtime -----------------------------------------------------
# The image that actually runs on Railway. ffmpeg is installed HERE so the
# binary is available at runtime for frame extraction (Req 6.5, 8.1).
FROM node:20-bookworm-slim AS runtime

# Install ffmpeg at build time into the final image (Debian apt-get). Clean the
# apt lists afterward to keep the image small. --no-install-recommends avoids
# pulling unnecessary packages.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Carry over the production node_modules, the compiled worker, and the manifest
# (so `npm start` resolves and version metadata is present).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Run as the non-root user that the Node base image already provides.
USER node

# Start the long-running worker poll loop (Req 6.4). Secrets (DATABASE_URL,
# BLOB_READ_WRITE_TOKEN) are supplied by the Railway environment at runtime and
# are never baked into the image (Req 14.1).
CMD ["node", "dist/index.js"]
