# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
  && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN pnpm build

FROM base AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '4000') + '/health/ready').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]
