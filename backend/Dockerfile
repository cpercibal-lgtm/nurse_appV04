# syntax=docker/dockerfile:1
# API and worker image (decision D-49: Google Cloud, me-central2).
# Build from the repository root:  docker build -f backend/Dockerfile -t api .
#
# Targets:
#   runtime (default) — `node dist/server.js` (API); the worker runs the same
#                       image with `node dist/jobs/worker.js`
#   migrate           — `prisma migrate deploy` with MIGRATION_DATABASE_URL
#                       (the release step; carries the Prisma CLI, which the
#                       runtime image does not)
#
# Behind a TLS-inspecting proxy, pass its CA for the npm install only (never
# stored in the image):  docker build --secret id=ca,src=/path/to/ca.pem ...

# Base images are pinned by digest (QA F2): the tag says which release, the digest which exact image.
# Dependabot (/backend, /frontend) moves tag and digest together.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --workspace backend --include-workspace-root=false
COPY backend backend
# prisma generate reads the datasource URL from prisma.config.ts but never connects.
RUN DATABASE_URL=postgresql://build@localhost/build npm run build -w backend

# ── release step: migrations only ──────────────────────────────────────────
FROM build AS migrate
ENV NODE_ENV=production
USER node
WORKDIR /app/backend
CMD ["npx", "prisma", "migrate", "deploy"]

# ── runtime: production dependencies and compiled code only ────────────────
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --workspace backend --include-workspace-root=false --omit=dev && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
WORKDIR /app/backend
# Uploaded documents (STORAGE_DIR); mounted from the VM's persistent disk.
RUN mkdir -p /data/storage && chown node:node /data/storage
ENV STORAGE_DIR=/data/storage PORT=3001
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
