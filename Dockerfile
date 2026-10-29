FROM node:22-bookworm-slim AS deps
# better-sqlite3 compiles from source when no prebuilt binary matches this Node
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
# Claude Code CLI: food parsing runs through it on a Claude subscription
RUN npm install -g @anthropic-ai/claude-code@2.1.312 && npm cache clean --force
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
VOLUME /data
EXPOSE 8080
CMD ["node", "src/server.js"]
