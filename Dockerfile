FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY . .
RUN npm run build

# Install supergateway globally (pinned for reproducibility)
RUN npm install -g supergateway@3.4.3

# Persistent storage for SQLite
RUN mkdir -p /data

ENV NODE_ENV=production
ENV KEEPA_DB_PATH=/data/keepa.db
# PORT is set by Railway automatically
# KEEPA_API_KEY and KEEPA_TOKENS_PER_MINUTE are set as Railway env vars

EXPOSE 3000

# Stateful Streamable HTTP mode: spawns a fresh stdio subprocess per MCP session,
# fixing the "Already connected to a transport" crash on concurrent clients.
# MCP endpoint: /mcp  |  Railway healthcheck endpoint: /sse (returns "ok").
CMD sh -c "supergateway --stdio 'node /app/dist/index.js' --outputTransport streamableHttp --stateful --sessionTimeout 600000 --port ${PORT:-3000} --healthEndpoint /sse"
