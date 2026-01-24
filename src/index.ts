import 'dotenv/config';
import http from 'http';
import { bot, notifyAdminsBotAlive } from './bot';
import { Scraper } from './scrapper';

async function main() {
    console.log('Starting app...');

    // 1. Start Healthcheck Server (for Docker)
    const healthServer = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
    });
    healthServer.listen(8080, () => {
        console.log('Healthcheck server running on port 8080');
    });

    // 2. Start Bot (Long Polling)
    bot.start({
        onStart: async (info) => {
            console.log(`Bot started as @${info.username}`);
            await notifyAdminsBotAlive();
        }
    });

    // 3. Start Scraper
    const scraper = new Scraper(1);
    scraper.start();
}

main().catch((err) => {
    console.error('Error starting app:', err);
});
