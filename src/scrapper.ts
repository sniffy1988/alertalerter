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
        .replace(/✅ Підпишись на СХІ[ДD]/gi, ' ')
        .replace(/[’ʼ]/g, "'")    // Normalize apostrophes
        .replace(/[^\S\r\n]+/g, ' ') // Collapse spaces/tabs but KEEP newlines (\r\n)
        .trim();
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

        const toScrape: typeof channels = [];
        for (const channel of channels) {
            const lastScrape = channel.lastScrapedAt ? new Date(channel.lastScrapedAt).getTime() : 0;
            const elapsed = now.getTime() - lastScrape;
            if (elapsed >= channel.scrapTimeout) {
                const worker = this.workers.get(channel.id);
                if (worker) {
                    const username = channel.link.split('/').pop() || '';
                    worker.postMessage({ username, channelId: channel.id });
                    toScrape.push(channel);
                }
            }
        }
        // Batch lastScrapedAt updates in one transaction
        if (toScrape.length > 0) {
            await prisma.$transaction(
                toScrape.map(ch => prisma.channel.update({ where: { id: ch.id }, data: { lastScrapedAt: now } }))
            );
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

        type MessageRow = { telegramId: bigint; message: string; mediaUrl?: string; mediaType?: string; date: Date; channelId: number; sent: boolean };
        const allMessagesToPersist: MessageRow[] = [];
        type Prepared = { outMessage: string; mediaUrl?: string; mediaType?: 'photo' | 'video'; telegramId: number };
        const prepared: Prepared[] = [];

        // 4. PREPARE: save all new messages (with sent flag); build payloads for alerts only
        for (const msg of messages) {
            if (existingIdsSet.has(msg.telegramId.toString())) continue;

            const cleanedText = cleanMessage(msg.text);
            const normalizedText = normalize(cleanedText);
            const passedFilter =
                !excludeRules.some(p => normalizedText.includes(p)) &&
                includeRules.some(p => normalizedText.includes(p));

            allMessagesToPersist.push({
                telegramId: BigInt(msg.telegramId),
                message: cleanedText,
                mediaUrl: msg.mediaUrl,
                mediaType: msg.mediaType,
                date: msg.date,
                channelId,
                sent: passedFilter
            });

            if (!passedFilter) continue;

            const now = new Date();
            const receivedTime = now.toLocaleTimeString('uk-UA', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Kyiv'
            });
            const escapedText = esc(cleanedText);
            const quotedText = escapedText.split('\n').map(line => `>${line}`).join('\n');
            const outMessage = `🔔 *${escapedName}*\n${quotedText}\n\n🕒 \`${esc(receivedTime)}\``;
            prepared.push({ outMessage, mediaUrl: msg.mediaUrl, mediaType: msg.mediaType, telegramId: msg.telegramId });
        }

        // 5. SEND: fire all sends in parallel (all messages × all subscribers at once)
        if (prepared.length > 0 && subscribers.length > 0) {
            const options = { parse_mode: 'MarkdownV2' as const };
            const allSends = prepared.flatMap(p =>
                subscribers.map(user => {
                    const chatId = Number(user.telegramId);
                    const opts = { ...options, caption: p.outMessage };
                    if (p.mediaUrl) {
                        if (p.mediaType === 'photo') return bot.api.sendPhoto(chatId, p.mediaUrl, opts).catch(() => { });
                        if (p.mediaType === 'video') return bot.api.sendVideo(chatId, p.mediaUrl, opts).catch(() => { });
                    }
                    return bot.api.sendMessage(chatId, p.outMessage, options).catch(() => { });
                })
            );
            await Promise.all(allSends);
            prepared.forEach(p => logger.info(`🚨 Speed Broadcast: Alert triggered for ${p.telegramId}`, channelId));
        }

        // 6. PERSIST: save all scraped messages (sent = true only for those broadcast)
        if (allMessagesToPersist.length > 0) {
            try {
                await prisma.message.createMany({
                    data: allMessagesToPersist.map(m => ({
                        telegramId: m.telegramId,
                        message: m.message,
                        mediaUrl: m.mediaUrl,
                        mediaType: m.mediaType,
                        date: m.date,
                        sent: m.sent,
                        channelId: m.channelId
                    }))
                });
            } catch (e) {
                // Fail silently for DB errors on logging
            }
        }
    }
}
