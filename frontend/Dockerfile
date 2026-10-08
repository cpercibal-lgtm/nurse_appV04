# syntax=docker/dockerfile:1
# Web image: the built frontend behind nginx, proxying /api to the API
# (decision D-49). Build from the repository root:
#   docker build -f frontend/Dockerfile -t web .
# Behind a TLS-inspecting proxy add  --secret id=ca,src=/path/to/ca.pem  (install only).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --workspace frontend --include-workspace-root=false
COPY frontend frontend
# The build includes the gzipped bundle budget gate.
RUN NODE_ENV=production npm run build -w frontend

FROM nginx:1.30-alpine AS runtime
# Unprivileged: nginx listens on 8080 and runs as the nginx user.
RUN sed -i 's/^user .*;//' /etc/nginx/nginx.conf \
 && sed -i 's#^pid .*;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
 && chown -R nginx:nginx /var/cache/nginx /etc/nginx/conf.d
COPY frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:3001 LB_PROXY_SUBNET=127.0.0.1/32
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
