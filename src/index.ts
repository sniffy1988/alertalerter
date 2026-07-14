import 'dotenv/config';
import http from 'http';
import { bot, notifyAdminsBotAlive } from './bot';
import { Scraper } from './scrapper';
import { registerAlertSender } from './alertSender';
import { MessageProcessor } from './messageProcessor';
import { TelegramListener } from './telegramListener';
import { getIngestMode } from './telegramConfig';
import { probeTelegramWebScrape } from './telegramWebScrape';
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
            logger.error('MTProto listener failed to start — using web scrape fallback only', undefined, { error: err });
            listener = null;
        }
    } else {
        logger.info('Ingest mode: web scrape only (t.me / telegram.me; set TELEGRAM_API_ID/HASH/SESSION for MTProto)');
    }

    const webProbe = await probeTelegramWebScrape();
    if (webProbe.workingHost) {
        const failed = webProbe.attempts.filter(a => !a.ok);
        if (failed.length > 0) {
            logger.warn('Web scrape probe: using fallback host', undefined, {
                host: webProbe.workingHost,
                failed: failed.map(a => ({ host: a.host, error: a.error }))
            });
        } else {
            logger.info('Web scrape probe OK', undefined, { host: webProbe.workingHost });
        }
    } else {
        logger.error('Web scrape probe failed for all hosts', undefined, {
            attempts: webProbe.attempts.map(a => ({ host: a.host, error: a.error }))
        });
    }

    const scraper = new Scraper(0.2, processor);
    void scraper.start();
}

main().catch((err) => {
    console.error('Error starting app:', err);
});
