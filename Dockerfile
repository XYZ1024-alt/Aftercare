# syntax=docker/dockerfile:1

# One image for both processes: the console (Next.js, built) and the worker
# (TypeScript executed through tsx). They share the workspace so that the
# console and the worker always run the same code and the same migrations.
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