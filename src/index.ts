import 'dotenv/config';
import http from 'http';
import { bot, notifyAdminsBotAlive } from './bot';
import { Scraper } from './scrapper';
import { registerAlertSender } from './alertSender';

// Flow: App starts → Scraper runs its own cycle per channel → Messages written to DB →
//       If message should be sent (filter match), fire event with send data →
//       Bot is notified by event and sends message to subscribers.

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

    // 3. Bot listens for scraper events and sends messages (event-driven)
    registerAlertSender();

    // 4. Scraper: runs its own cycle per channel; writes to DB; fires event when message should be sent
    const scraper = new Scraper(1);
    scraper.start();
}

main().catch((err) => {
    console.error('Error starting app:', err);
});
