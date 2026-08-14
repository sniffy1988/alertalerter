import 'dotenv/config';
import http from 'http';
import { bot, notifyAdminsBotAlive } from './bot';
import { Scraper } from './scrapper';
import { registerAlertSender } from './alertSender';
import { MessageProcessor } from './messageProcessor';
import { TelegramListener } from './telegramListener';
import { getIngestMode } from './telegramConfig';
import { logger } from './logger';

const MTPROTO_STALE_MS = 120_000;

async function main() {
    console.log('Starting app...');

    const processor = new MessageProcessor();
    const ingestMode = getIngestMode();
    let listener: TelegramListener | null = null;
    let scraper: Scraper | null = null;

    const scrapeEnabled = (): boolean => {
        if (ingestMode === 'scrape') return true;
        if (!listener) return true;
        if (!listener.isHealthy()) return true;
        const last = listener.getLastMessageAt();
        if (last === 0) return true;
        return Date.now() - last > MTPROTO_STALE_MS;
    };

    const healthServer = http.createServer((req, res) => {
        if (req.url === '/health') {
            const last = listener?.getLastMessageAt() ?? 0;
            const body = {
                ingestMode,
                mtprotoHealthy: listener?.isHealthy() ?? false,
                watchedChannels: listener?.getWatchedChannelCount() ?? 0,
                lastMessageAt: last > 0 ? new Date(last).toISOString() : null,
                scrapeActive: scraper?.isPoolActive() ?? false
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
            return;
        }
        res.writeHead(200);
        res.end('OK');
    });
    healthServer.listen(8080, () => {
        console.log('Healthcheck server running on port 8080');
    });

    bot.start({
        onStart: async (info) => {
            console.log(`Bot started as @${info.username}`);
            await notifyAdminsBotAlive();
        }
    });

    registerAlertSender();

    if (ingestMode === 'mtproto') {
        listener = new TelegramListener(processor);
        try {
            await listener.start();
        } catch (err) {
            logger.error('MTProto listener failed to start — using web scrape fallback only', undefined, { error: err });
            listener = null;
        }
    } else {
        logger.info('Ingest mode: web scrape only (t.me / telegram.me; set TELEGRAM_API_ID/HASH/SESSION for MTProto)');
    }

    scraper = new Scraper(0.2, processor, { enabled: scrapeEnabled });
    void scraper.start();
}

main().catch((err) => {
    console.error('Error starting app:', err);
});
