FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY . .
RUN npm run build

# Install supergateway globally
RUN npm install -g supergateway

# Persistent storage for SQLite
RUN mkdir -p /data

ENV NODE_ENV=production
ENV KEEPA_DB_PATH=/data/keepa.db
# PORT is set by Railway automatically
# KEEPA_API_KEY and KEEPA_TOKENS_PER_MINUTE are set as Railway env vars

EXPOSE 3000

CMD sh -c "supergateway --stdio 'node /app/dist/index.js' --port ${PORT:-3000}"
