import 'dotenv/config';
import http from 'http';
import { bot, notifyAdminsBotAlive } from './bot';
import { Scraper } from './scrapper';
import { registerAlertSender } from './alertSender';
import { MessageProcessor } from './messageProcessor';

async function main() {
    console.log('Starting app...');

    const processor = new MessageProcessor();
    const scraper = new Scraper(0.2, processor);

    const healthServer = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(scraper.getHealth()));
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
    void scraper.start();
}

main().catch((err) => {
    console.error('Error starting app:', err);
});
