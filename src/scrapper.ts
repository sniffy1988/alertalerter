import path from 'path';
import { Worker } from 'worker_threads';
import prisma from './db';
import { logger } from './logger';

// Helper to sleep/wait
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ScrapedMessage {
    telegramId: number;
    text: string;
    mediaUrl?: string;
    mediaType?: 'photo' | 'video';
    date: Date;
    sender?: string;
}

interface WorkerResult {
    success: boolean;
    channelId: number;
    username: string;
    messages?: ScrapedMessage[];
    error?: any;
    log?: string;
}

// Helper to strip unwanted strings and normalize text for better matching
function cleanMessage(text: string): string {
    return text
        .replace(/📷TlkInst/gi, ' ')
        .replace(/🎞Канал со стримами/gi, ' ')
        .replace(/✅ Підпишись на СХІД/gi, ' ')
        .replace(/[’ʼ]/g, "'")    // Normalize apostrophes
        .replace(/[^\S\r\n]+/g, ' ') // Collapse spaces/tabs but KEEP newlines (\r\n)
        .trim();
}

// Helper to filter messages based on database dictionary
async function shouldSendMessage(text: string): Promise<boolean> {
    // Normalization helper for consistent matching
    const normalize = (s: string) =>
        s.toLowerCase()
            .replace(/[’ʼ]/g, "'")
            .trim();

    const normalizedText = normalize(text);

    // Fetch all rules from DB
    const rules = await prisma.filterPhrase.findMany();

    // 1. Check for ANY exclusion matches - if found, block immediately.
    // We normalize rule phrases during check to handle inconsistent DB entries.
    const hasExclude = rules.some(p => p.exclude && normalizedText.includes(normalize(p.phrase)));
    if (hasExclude) return false;

    // 2. Check for AT LEAST ONE inclusion match - if found, allow.
    const hasInclude = rules.some(p => !p.exclude && normalizedText.includes(normalize(p.phrase)));
    return hasInclude;
}

export class Scraper {
    private isRunning = false;
    private intervalSeconds: number;
    private workers: Map<number, Worker> = new Map();

    constructor(intervalSeconds: number = 2) {
        this.intervalSeconds = intervalSeconds;
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`Scraper started with DB-driven filtering, triggering every ${this.intervalSeconds} seconds.`);

        await this.refreshWorkers();

        while (this.isRunning) {
            try {
                await this.triggerScrapeCycle();
            } catch (error) {
                logger.error('Error during scrape cycle:', undefined, { error });
            }
            await this.refreshWorkers();
            await delay(this.intervalSeconds * 1000);
        }
    }

    private async refreshWorkers() {
        const channels = await prisma.channel.findMany();

        for (const channel of channels) {
            if (!this.workers.has(channel.id)) {
                this.spawnWorker(channel.id, channel.link);
            }
        }
    }

    private spawnWorker(id: number, link: string) {
        const username = link.split('/').pop() || '';

        const isTS = __filename.endsWith('.ts');
        const workerExt = isTS ? '.ts' : '.js';
        const workerPath = path.resolve(__dirname, `./scraper.worker${workerExt}`);

        const execArgv = isTS ? ['-r', 'ts-node/register'] : [];

        const worker = new Worker(workerPath, {
            execArgv,
            workerData: { isTS }
        });

        worker.on('message', async (result: WorkerResult) => {
            if (result.success && result.messages) {
                await this.processMessages(result.channelId, result.messages);
            } else if (result.error) {
                logger.error(`Worker error for ${result.username}:`, result.channelId, { error: result.error });
            }
        });

        worker.on('error', (err) => {
            logger.error(`Worker crash for channel ${id}:`, id, { error: err });
            this.workers.delete(id);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn(`Worker for channel ${id} stopped with code ${code}`, id);
            }
            this.workers.delete(id);
        });

        this.workers.set(id, worker);
    }

    private async triggerScrapeCycle() {
        const now = new Date();
        const channels = await prisma.channel.findMany();

        for (const channel of channels) {
            const lastScrape = channel.lastScrapedAt ? new Date(channel.lastScrapedAt).getTime() : 0;
            const elapsed = now.getTime() - lastScrape;

            if (elapsed >= channel.scrapTimeout) {
                const worker = this.workers.get(channel.id);
                if (worker) {
                    const username = channel.link.split('/').pop() || '';
                    worker.postMessage({ username, channelId: channel.id });

                    // Update lastScrapedAt
                    await prisma.channel.update({
                        where: { id: channel.id },
                        data: { lastScrapedAt: now }
                    });
                }
            }
        }
    }

    private async processMessages(channelId: number, messages: ScrapedMessage[]) {
        const { bot } = await import('./bot');

        // 1. Pre-fetch everything needed for this batch in one go
        const [channelInfo, subscribers, rules] = await Promise.all([
            prisma.channel.findUnique({ where: { id: channelId } }),
            prisma.user.findMany({
                where: { subscribedTo: { some: { id: channelId } }, silentMode: false }
            }),
            prisma.filterPhrase.findMany()
        ]);

        if (!channelInfo) return;
        const channelName = channelInfo.name || channelInfo.link || 'Alert';

        // 2. Setup high-speed lookups
        const normalize = (s: string) => s.toLowerCase().replace(/[’ʼ]/g, "'").trim();
        const esc = (text: string) => text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
        const escapedName = esc(channelName);

        const excludeRules = rules.filter(r => r.exclude).map(r => normalize(r.phrase));
        const includeRules = rules.filter(r => !r.exclude).map(r => normalize(r.phrase));

        // 3. BATCH DUPLICATE CHECK (Fetch all relevant IDs once)
        const msgIds = messages.map(m => BigInt(m.telegramId));
        const existingMessages = await prisma.message.findMany({
            where: { channelId, telegramId: { in: msgIds } },
            select: { telegramId: true }
        });
        const existingIdsSet = new Set(existingMessages.map(m => m.telegramId.toString()));

        for (const msg of messages) {
            const telegramIdBigInt = BigInt(msg.telegramId);
            const cleanedText = cleanMessage(msg.text);
            const normalizedText = normalize(cleanedText);

            // 4. FAST FILTERING (In-Memory)
            if (excludeRules.some(p => normalizedText.includes(p))) continue;
            if (!includeRules.some(p => normalizedText.includes(p))) continue;

            // 5. DUPLICATE CHECK (In-Memory Set lookup)
            if (existingIdsSet.has(msg.telegramId.toString())) continue;

            // 6. BROADCAST PREP
            const now = new Date();
            const receivedTime = now.toLocaleTimeString('uk-UA', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Kyiv'
            });

            const escapedText = esc(cleanedText);
            const quotedText = escapedText.split('\n').map(line => `>${line}`).join('\n');
            const outMessage = `🔔 *${escapedName}*\n${quotedText}\n\n🕒 \`${esc(receivedTime)}\``;

            // 7. HOT PATH: TRIGGER BROADCASTS (Parallel)
            const sendPromises = subscribers.map(user => {
                const targetUserId = Number(user.telegramId);
                const options = { caption: outMessage, parse_mode: 'MarkdownV2' as const };

                if (msg.mediaUrl) {
                    if (msg.mediaType === 'photo') return bot.api.sendPhoto(targetUserId, msg.mediaUrl, options).catch(() => { });
                    if (msg.mediaType === 'video') return bot.api.sendVideo(targetUserId, msg.mediaUrl, options).catch(() => { });
                }
                return bot.api.sendMessage(targetUserId, outMessage, { parse_mode: 'MarkdownV2' }).catch(() => { });
            });

            // Fire-and-forget: Start broadcasting immediately
            Promise.all(sendPromises).then(async () => {
                // Background DB Logging - doesn't block the next message in the loop
                try {
                    await prisma.message.create({
                        data: {
                            telegramId: telegramIdBigInt,
                            message: cleanedText,
                            mediaUrl: msg.mediaUrl,
                            mediaType: msg.mediaType,
                            date: msg.date,
                            sent: true,
                            channelId: channelId
                        }
                    });
                } catch (e) {
                    // Fail silently for DB errors on hot path logging
                }
            });

            logger.info(`🚨 Speed Broadcast: Alert triggered for ${msg.telegramId}`, channelId);
        }
    }
}
