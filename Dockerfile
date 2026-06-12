FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
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
USER fintrack
EXPOSE 3000
CMD ["node", "dist/server.js"]
