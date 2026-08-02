FROM node:22-alpine
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/relayer ./apps/relayer

RUN pnpm install --frozen-lockfile=false

WORKDIR /repo/apps/relayer
EXPOSE 8787
# Migrations run on boot: the schema is small and idempotent, so a separate
# migration step would be ceremony rather than safety.
CMD ["pnpm", "start"]
