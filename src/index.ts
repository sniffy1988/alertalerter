import 'dotenv/config';
import http from 'http';
import { bot, notifyAdminsBotAlive } from './bot';
import { Scraper } from './scrapper';
import { registerAlertSender } from './alertSender';
import { MessageProcessor } from './messageProcessor';
import { TelegramListener } from './telegramListener';
import { getIngestMode } from './telegramConfig';
import { logger } from './logger';

async function main() {
    console.log('Starting app...');

    const healthServer = http.createServer((_req, res) => {
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

    const processor = new MessageProcessor();
    const ingestMode = getIngestMode();
    let listener: TelegramListener | null = null;

    if (ingestMode === 'mtproto') {
        listener = new TelegramListener(processor);
        try {
            await listener.start();
        } catch (err) {
            logger.error('MTProto listener failed to start — using t.me fallback only', undefined, { error: err });
            listener = null;
        }
    } else {
        logger.info('Ingest mode: t.me scrape only (set TELEGRAM_API_ID/HASH/SESSION for MTProto)');
    }

    const scraper = new Scraper(0.2, processor, {
        enabled: () => !listener?.isHealthy()
    });
    void scraper.start();
}

main().catch((err) => {
    console.error('Error starting app:', err);
});
