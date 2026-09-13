# ─────────────────────────────────────────────────────────────────────────────
# Build for a single-container deploy (Coolify / any Docker host).
#
# Debian slim rather than Alpine on purpose: @napi-rs/canvas (the card and
# chart renderer) ships glibc prebuilds. On Alpine/musl npm falls through to
# building from source, which needs a full toolchain and frequently just fails.
#
# SQLite means this must run as exactly ONE replica. Do not scale it — two
# containers writing the same database file will corrupt it.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:24-slim AS builder
WORKDIR /app

# npm major must match the one that wrote package-lock.json. `npm ci` is
# strict: npm 10 and npm 11 disagree about this tree (npm 10 demands a nested
# utf-8-validate@5.0.10 that npm 11 does not record), so a lock written locally
# on npm 11 fails to install on an image shipping npm 10. Pinning here makes
# the build independent of whatever the base image happens to bundle.
RUN npm install -g npm@11

# openssl is required by Prisma's query engine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Generate the client before compiling — tsc needs its types.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc


FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# node_modules is copied wholesale rather than reinstalled with --omit=dev
# because `prisma migrate deploy` runs at container start and the CLI is a dev
# dependency. Copying also guarantees the generated client is byte-identical to
# the one the build compiled against.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

# Bundled font. Headless containers ship no system fonts and canvas draws
# nothing rather than erroring, so cards and charts come out blank without it.
COPY assets ./assets

# SQLite lives here. MOUNT A VOLUME AT /data — without one the database is
# destroyed on every redeploy.
RUN mkdir -p /data
ENV DATABASE_URL="file:/data/bot.db"

EXPOSE 10000

# TCP probe rather than an HTTP route: the Telegraf webhook server only answers
# on its secret webhook path, so an HTTP healthcheck against / would fail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('net').connect(Number(process.env.PORT)||10000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

# Migrations are NOT run here. SQLite allows a single writer, so running
# `migrate deploy` at container start races the old container during a rolling
# deploy and dies with "database is locked" -- which then prevents this
# container going healthy, so the old one is never stopped. Deadlock.
#
# Migrations run as a post-deployment command instead, once the old container
# is gone. See DEPLOY.md.
CMD ["node", "dist/bot.js"]
