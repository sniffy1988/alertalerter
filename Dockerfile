# Build Stage
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install

COPY . .

RUN npx prisma generate
RUN npm run build

# Production Stage
FROM node:20-slim

WORKDIR /app

# SQLite library dependency
RUN apt-get update && apt-get install -y openssl curl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Expose port for Prisma Studio (default 5555)
EXPOSE 5555

# Set environment variables
ENV NODE_ENV=production

# Use a startup script to run migrations
COPY start.sh .
RUN chmod +x start.sh

CMD ["./start.sh"]
