# ── Stage 1: Build Fractal ───────────────────────────────────
FROM node:20-slim AS fractal-build

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ARG CACHEBUST=0
ARG GIT_REF=main
RUN git clone --branch ${GIT_REF} --single-branch https://github.com/redswoop/fractal.git .
RUN npm ci && npm run build

# ── Stage 2: Final image ────────────────────────────────────
FROM lscr.io/linuxserver/code-server:latest

# Install Node.js (Fractal runtime dependency)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Fractal server ──────────────────────────────────────────
COPY --from=fractal-build /build/dist /opt/fractal/dist
COPY --from=fractal-build /build/node_modules /opt/fractal/node_modules
COPY --from=fractal-build /build/package.json /opt/fractal/package.json
COPY --from=fractal-build /build/fractalignore /opt/fractal/fractalignore
COPY --from=fractal-build /build/templates /opt/fractal/templates

# s6 service: run Fractal as a supervised daemon
COPY fractal-run.sh /etc/services.d/fractal/run

ENV FRACTAL_PROJECTS_ROOT=/projects/fractal/projects
ENV DEFAULT_WORKSPACE=/projects/fractal/projects
ENV GIT_USER_NAME="Armen Nakashian"
ENV GIT_USER_EMAIL="anakashian@gmail.com"

# ── VS Code setup ───────────────────────────────────────────
COPY install-extensions.sh /custom-cont-init.d/10-install-extensions
COPY disable-shell.sh /custom-cont-init.d/99-disable-shell
COPY settings.json /defaults/settings.json

EXPOSE 3001
