FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The Prisma client is GENERATED, not committed — src/generated/ is in
# .gitignore, so it does not exist in a build that starts from the repository.
# Without this step tsc fails on ~40 files with "Cannot find module
# '../generated/prisma/client'", which is what it did.
#
# The placeholder URL is only here because prisma.config.ts resolves
# DATABASE_URL and DIRECT_URL when it loads. Generation reads the schema and
# never opens a connection, so the value is irrelevant — it just has to be
# present. The real ones arrive as runtime environment variables.
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
    DIRECT_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
    npx prisma generate

RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system fintrack && useradd --system --gid fintrack --home-dir /app fintrack
COPY --from=builder --chown=fintrack:fintrack /app/dist ./dist
COPY --from=builder --chown=fintrack:fintrack /app/node_modules ./node_modules
COPY --from=builder --chown=fintrack:fintrack /app/prisma ./prisma
COPY --from=builder --chown=fintrack:fintrack /app/package.json ./package.json
# Carried so `prisma migrate deploy` can run against the live database before
# the server starts. It resolves DATABASE_URL and DIRECT_URL at that point,
# which is why the placeholders above are never seen at runtime.
COPY --from=builder --chown=fintrack:fintrack /app/prisma.config.ts ./prisma.config.ts
USER fintrack
EXPOSE 3000
CMD ["node", "dist/server.js"]
