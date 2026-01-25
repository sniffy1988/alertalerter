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
        .replace(/📷TlkInst/g, ' ')
        .replace(/🎞Канал со стримами/g, ' ')
        .replace(/✅ Підпишись на СХІД/g, ' ')
        .replace(/[’ʼ]/g, "'")    // Normalize apostrophes
        .replace(/[^\S\r\n]+/g, ' ') // Collapse spaces/tabs but KEEP newlines (\r\n)
        .trim();
}

// Helper to filter messages based on database dictionary
async function shouldSendMessage(text: string): Promise<boolean> {
    const lowerText = text.toLowerCase();

    // Fetch all rules from DB
    const rules = await prisma.filterPhrase.findMany();

    // 1. Check for ANY exclusion matches - if found, block immediately.
    const hasExclude = rules.some(p => p.exclude && lowerText.includes(p.phrase.toLowerCase()));
    if (hasExclude) return false;

    // 2. Check for AT LEAST ONE inclusion match - if found, allow.
    const hasInclude = rules.some(p => !p.exclude && lowerText.includes(p.phrase.toLowerCase()));
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

        for (const msg of messages) {
            const telegramIdBigInt = BigInt(msg.telegramId);
            const cleanedText = cleanMessage(msg.text);

            const existing = await prisma.message.findFirst({
                where: {
                    telegramId: telegramIdBigInt,
                    channelId: channelId
                }
            });

            if (!existing) {
                try {
                    const saved = await prisma.message.create({
                        data: {
                            telegramId: telegramIdBigInt,
                            message: cleanedText,
                            mediaUrl: msg.mediaUrl,
                            mediaType: msg.mediaType,
                            date: msg.date,
                            sent: false,
                            channelId: channelId
                        }
                    });
                    logger.info(`Saved message ${saved.id} (TG: ${msg.telegramId})`, channelId);

                    // --- DB-DRIVEN DICTIONARY FILTERING ---
                    if (!(await shouldSendMessage(cleanedText))) {
                        logger.info(`Message ${msg.telegramId} filtered out by DB dictionary rules.`, channelId);
                        continue;
                    }

                    // --- BROADCAST TO SUBSCRIBERS ---
                    const subscribers = await prisma.user.findMany({
                        where: {
                            subscribedTo: { some: { id: channelId } },
                            silentMode: false
                        }
                    });

                    if (subscribers.length > 0) {
                        const channelInfo = await prisma.channel.findUnique({ where: { id: channelId } });
                        const receivedTime = saved.createdAt.toLocaleTimeString('uk-UA', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            timeZone: 'Europe/Kyiv'
                        });

                        const channelName = channelInfo?.name || channelInfo?.link || 'Alert';

                        // Helper to escape MarkdownV2 special characters
                        const esc = (text: string) => text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');

                        const escapedName = esc(channelName);
                        const escapedTime = esc(receivedTime);
                        const escapedText = esc(cleanedText);

                        // Premium Wide Quote layout (Style 1)
                        // Prepend > to each line of text for a consistent blockquote
                        const quotedText = escapedText
                            .split('\n')
                            .map(line => `>${line}`)
                            .join('\n');

                        const outMessage =
                            `🔔 *${escapedName}*\n` +
                            `${quotedText}\n\n` +
                            `🕒 \`${escapedTime}\``;

                        for (const user of subscribers) {
                            try {
                                const targetUserId = Number(user.telegramId);

                                if (msg.mediaUrl) {
                                    if (msg.mediaType === 'photo') {
                                        await bot.api.sendPhoto(targetUserId, msg.mediaUrl, {
                                            caption: outMessage,
                                            parse_mode: 'MarkdownV2'
                                        });
                                    } else if (msg.mediaType === 'video') {
                                        await bot.api.sendVideo(targetUserId, msg.mediaUrl, {
                                            caption: outMessage,
                                            parse_mode: 'MarkdownV2'
                                        });
                                    } else {
                                        await bot.api.sendMessage(targetUserId, outMessage, { parse_mode: 'MarkdownV2' });
                                    }
                                } else {
                                    await bot.api.sendMessage(targetUserId, outMessage, { parse_mode: 'MarkdownV2' });
                                }
                            } catch (err) {
                                logger.error(`Notification failed for user ${user.telegramId}`, channelId, { error: err });
                            }
                        }

                        await prisma.message.update({
                            where: { id: saved.id },
                            data: { sent: true }
                        });
                    }

                } catch (e) {
                    logger.error(`Skipped msg ${msg.telegramId} due to error:`, channelId, { error: e });
                }
            }
        }
    }
}
