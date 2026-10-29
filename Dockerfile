FROM node:22-bookworm-slim AS deps
# better-sqlite3 compiles from source when no prebuilt binary matches this Node
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
# The AI command-line tools to bake in, from PLATEFUL_CLIS in .env (space-separated):
# claude, codex, gemini, opencode. Ollama, OpenAI-compatible servers and custom commands need none.
ARG PLATEFUL_CLIS="claude"
RUN set -e; pkgs=""; \
    for c in $PLATEFUL_CLIS; do case "$c" in \
      claude) pkgs="$pkgs @anthropic-ai/claude-code@2.1.312" ;; \
      codex) pkgs="$pkgs @openai/codex" ;; \
      gemini) pkgs="$pkgs @google/gemini-cli" ;; \
      opencode) pkgs="$pkgs opencode-ai" ;; \
      none) ;; \
      *) echo "Unknown CLI in PLATEFUL_CLIS: $c" >&2; exit 1 ;; \
    esac; done; \
    if [ -n "$pkgs" ]; then npm install -g $pkgs && npm cache clean --force; fi
WORKDIR /app
# HOME inside the data folder, so CLI sign-ins (codex login, opencode auth login...) survive rebuilds
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOME=/data/home
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
VOLUME /data
EXPOSE 8080
CMD ["node", "src/server.js"]
