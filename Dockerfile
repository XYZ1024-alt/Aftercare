# syntax=docker/dockerfile:1

# Two runtimes share one build:
#   runtime — the console and worker of a Compose deployment (database lives in
#             another service, like docker-compose.yml);
#   studio  — the default target, a single container for a ModelScope Docker
#             Studio: its own PostgreSQL, the idempotent initialisation, the
#             worker and the console, listening on the platform's only port.
# A plain "docker build ." builds the last stage, so ModelScope gets the Studio
# image; docker-compose.yml names the "runtime" target explicitly.

FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
# Installed globally so the unprivileged runtime user does not have to download
# pnpm through corepack on every container start.
RUN npm install --global pnpm@12.11.2
WORKDIR /app

# Dependencies first: this layer is reused until a package.json or the lockfile changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY packages/casework/package.json ./packages/casework/package.json
COPY packages/console/package.json ./packages/console/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/evidence/package.json ./packages/evidence/package.json
COPY packages/execution/package.json ./packages/execution/package.json
COPY packages/repair/package.json ./packages/repair/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/verify/package.json ./packages/verify/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build:web

# ModelScope Studio displays the console inside an iframe on modelscope.cn.
# Only this build carries that exception; the ordinary runtime keeps refusing
# to be framed.
FROM deps AS build-studio
ENV AFTERCARE_CONSOLE_FRAME_ANCESTORS="https://modelscope.cn https://www.modelscope.cn"
COPY . .
RUN pnpm build:web

FROM base AS runtime
ENV NODE_ENV=production
# Used by docker/init.sh to inspect the database before seeding the demo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client socat \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
ENTRYPOINT ["/app/docker/entrypoint.sh"]
EXPOSE 3100
# Overridden by docker-compose for the worker and the one-off init service.
CMD ["pnpm", "--filter", "@aftercare/web", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3100"]

# ModelScope Docker Studio: one container is the whole deployment. The
# platform exposes 7860 only, restarts the container, and keeps only
# /mnt/workspace across restarts, so PostgreSQL and the artefact files live
# there. The image runs as root only long enough to start PostgreSQL as its
# own user; the initialisation, the worker and the console run as node.
FROM postgres:17-bookworm AS studio
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    AFTERCARE_STUDIO_ROOT=/mnt/workspace/aftercare \
    AFTERCARE_CONSOLE_FRAME_ANCESTORS="https://modelscope.cn https://www.modelscope.cn"
RUN groupadd --gid 1000 node \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/sh node
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=base /usr/local/bin/pnpm /usr/local/bin/pnpm
COPY --from=base /usr/local/bin/pnpx /usr/local/bin/pnpx
COPY --from=base /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
WORKDIR /app
COPY --from=build-studio --chown=1000:1000 /app /app
RUN chmod +x /app/docker/studio-start.sh
EXPOSE 7860
CMD ["/app/docker/studio-start.sh"]
