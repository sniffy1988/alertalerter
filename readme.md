# Alert Scrapper Bot

Telegram channel scrapper and notification bot.

Ingest is **t.me / telegram.me HTML scrape** of public channel preview pages. Alerts go out through the Telegram Bot API (`TELEGRAM_BOT_TOKEN`).

## Setup (Local)

1. **Install dependencies**: `npm install`
2. **Environment**: Copy `.env.example` to `.env`. Set `TELEGRAM_BOT_TOKEN`. Optional: `SCRAPER_POOL_SIZE=4`, `ALERT_SEND_CONCURRENCY=8`.
3. **Database**: `npx prisma migrate dev`
4. **Run**: `npm run dev`

```bash
curl -s http://127.0.0.1:8080/health
```

`/health` JSON includes `channelCount`, `scrapeActive`, `poolSize`, `lastScrapeAt`. `/` still returns `OK` for Docker healthchecks.

## Docker Deployment (Mac mini / Proxmox / Server)

CI builds and pushes a **multi-arch** image (`linux/amd64` + `linux/arm64`) to GitHub Container Registry on every push to `main`/`master`. Docker on Apple Silicon Mac mini pulls the `arm64` variant automatically.

### Mac mini (Docker Desktop)

1. Copy `docker-compose.yml` and create `.env` with `TELEGRAM_BOT_TOKEN`.
2. Pull and start (Prisma Studio is **off** unless you pass the profile):

```bash
docker compose pull
docker compose up -d
```

Healthcheck: `http://localhost:8080/`  
Status: `docker exec <app> wget -qO- http://127.0.0.1:8080/health`  
Prisma Studio: `docker compose --profile studio up -d` then `http://localhost:5555`

### 1. Build and Push (multi-arch, local)

Requires [Docker Buildx](https://docs.docker.com/build/building/multi-platform/). Pushes both architectures in one manifest:

```bash
docker login ghcr.io
IMAGE=ghcr.io/your-username/alertscrapper:latest ./scripts/docker-build-multiarch.sh --push
```

Single-platform local test (current machine only):

```bash
docker build -t alertscrapper:local .
```

### 2. Deploy with Docker Compose

Create a `docker-compose.yml` on your server. To use a **database file from outside** (the host filesystem), map a volume to `/database`:

```yaml
version: '3.8'

services:
  app:
    image: your-username/alertscrapper:latest
    restart: always
    environment:
      - DATABASE_URL=file:/database/alerts.db
      - TELEGRAM_BOT_TOKEN=your_bot_token_here
      - SCRAPER_POOL_SIZE=4
      - ALERT_SEND_CONCURRENCY=8
    volumes:
      # Change './db_data' to any absolute path on your host (e.g. /mnt/data/mybot)
      - ./db_data:/database
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  studio:
    profiles: ["studio"]
    image: your-username/alertscrapper:latest
    restart: always
    command: npx prisma studio --browser none --port 5555 --hostname 0.0.0.0
    ports:
      - "5555:5555"
    environment:
      - DATABASE_URL=file:/database/alerts.db
    volumes:
      - ./db_data:/database
    depends_on:
      - app
```

### 3. Using an "Outside" Database File
By mapping `./db_data:/database`, the file `alerts.db` will be created inside your host's `./db_data` folder.
*   If you want to move the database, just move the folder.
*   If you want to use an existing file, rename it to `alerts.db`, put it in the folder, and Docker will mount it.

### 4. Database Viewer
Start with `docker compose --profile studio up -d` and open:
`http://your-server-ip:5555`

## Features
*   **Web scrape ingest**: polls public `t.me/s/{username}` preview pages.
*   **Worker Threads**: scrape pool (`SCRAPER_POOL_SIZE`, default 4).
*   **External DB**: SQLite file persistence via Docker volumes.
*   **Menu System**: Persistent bot keyboard for settings and subs.
