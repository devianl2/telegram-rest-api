# Do not use alpine base image for gramjs: https://github.com/gram-js/gramjs/issues/637
# Alpine uses musl libc which breaks GramJS's MTProto Diffie-Hellman key exchange
# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ─── Stage 2: Production ─────────────────────────────────────────────────────
FROM node:22-slim AS production

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]
