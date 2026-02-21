import os from 'os';
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

interface ScrapeJob {
    channelId: number;
    username: string;
}

type PoolEntry = { worker: Worker; busy: boolean; currentJob?: ScrapeJob };

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

type CachedChannel = { id: number; link: string; lastScrapedAt: Date | null; scrapTimeout: number; name: string | null };
type CachedRule = { phrase: string; exclude: boolean };

/** Worker pool with job queue; each channel has its own scrapTimeout (ms) from DB. */
export class Scraper {
    private isRunning = false;
    private intervalSeconds: number;
    /** Fixed pool of workers. */
    private pool: PoolEntry[] = [];
    /** Jobs waiting to be dispatched. */
    private jobQueue: ScrapeJob[] = [];
    /** Channel IDs currently being scraped (dispatched but result not yet received). */
    private inFlight = new Set<number>();
    private channelCache = new Map<number, CachedChannel>();
    private rulesCache: CachedRule[] = [];
    private lastRulesRefreshAt = 0;
    private static readonly RULES_CACHE_TTL_MS = 60_000;
    private static readonly POOL_SIZE = Math.min(8, Math.max(1, 2 * os.cpus().length));

    constructor(intervalSeconds: number = 2) {
        this.intervalSeconds = intervalSeconds;
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`Scraper started with pool of ${Scraper.POOL_SIZE} workers, triggering every ${this.intervalSeconds} seconds.`);

        await this.refreshChannelCache();
        await this.refreshRulesCache();
        this.initPool();
        try {
            await this.triggerScrapeCycle();
        } catch (error) {
            logger.error('Error during initial scrape cycle:', undefined, { error });
        }

        while (this.isRunning) {
            if (Date.now() - this.lastRulesRefreshAt > Scraper.RULES_CACHE_TTL_MS) {
                await this.refreshRulesCache();
            }
            await delay(this.intervalSeconds * 1000);
            try {
                await this.triggerScrapeCycle();
            } catch (error) {
                logger.error('Error during scrape cycle:', undefined, { error });
            }
        }
    }

    private async refreshChannelCache() {
        const channels = await prisma.channel.findMany({
            select: { id: true, link: true, lastScrapedAt: true, scrapTimeout: true, name: true }
        });
        this.channelCache = new Map(channels.map(c => [c.id, c]));
    }

    private async refreshRulesCache() {
        const rules = await prisma.filterPhrase.findMany();
        this.rulesCache = rules.map(r => ({ phrase: r.phrase, exclude: r.exclude }));
        this.lastRulesRefreshAt = Date.now();
    }

    private getWorkerPath(): string {
        const isTS = __filename.endsWith('.ts');
        const workerExt = isTS ? '.ts' : '.js';
        return path.resolve(__dirname, `./scraper.worker${workerExt}`);
    }

    private createPoolWorker(): PoolEntry {
        const isTS = __filename.endsWith('.ts');
        const worker = new Worker(this.getWorkerPath(), {
            execArgv: isTS ? ['-r', 'ts-node/register'] : [],
            workerData: { isTS }
        });
        const entry: PoolEntry = { worker, busy: false };

        worker.on('message', (result: WorkerResult) => this.handleWorkerResult(entry, result));
        worker.on('error', (err) => {
            logger.error('Worker crash', undefined, { error: err });
            entry.busy = false;
            if (entry.currentJob) this.inFlight.delete(entry.currentJob.channelId);
            entry.currentJob = undefined;
            this.removeFromPool(entry);
            this.replacePoolWorker(entry);
        });
        worker.on('exit', (code) => {
            if (code !== 0) logger.warn(`Worker exited with code ${code}`);
            entry.busy = false;
            if (entry.currentJob) this.inFlight.delete(entry.currentJob.channelId);
            entry.currentJob = undefined;
            this.removeFromPool(entry);
            this.replacePoolWorker(entry);
        });

        return entry;
    }

    private removeFromPool(entry: PoolEntry) {
        const i = this.pool.indexOf(entry);
        if (i !== -1) this.pool.splice(i, 1);
    }

    private replacePoolWorker(_removed: PoolEntry) {
        if (!this.isRunning || this.pool.length >= Scraper.POOL_SIZE) return;
        this.pool.push(this.createPoolWorker());
    }

    private initPool() {
        for (let i = 0; i < Scraper.POOL_SIZE; i++) {
            this.pool.push(this.createPoolWorker());
        }
    }

    private handleWorkerResult(entry: PoolEntry, result: WorkerResult) {
        this.inFlight.delete(result.channelId);
        entry.busy = false;
        entry.currentJob = undefined;
        if (result.success && result.messages) {
            this.processMessages(result.channelId, result.messages).catch((err) =>
                logger.error('processMessages error', result.channelId, { error: err })
            );
        } else if (result.error) {
            logger.error(`Worker error for ${result.username}:`, result.channelId, { error: result.error });
        }
        this.dispatchNext();
    }

    private getIdleWorker(): PoolEntry | undefined {
        return this.pool.find(p => !p.busy);
    }

    private dispatchNext() {
        if (this.jobQueue.length === 0) return;
        const entry = this.getIdleWorker();
        if (!entry) return;
        const job = this.jobQueue.shift()!;
        this.inFlight.add(job.channelId);
        entry.busy = true;
        entry.currentJob = job;
        entry.worker.postMessage(job);
    }

    private async triggerScrapeCycle() {
        const now = new Date();
        const channels = Array.from(this.channelCache.values());

        const toScrape: CachedChannel[] = [];
        for (const channel of channels) {
            const lastScrape = channel.lastScrapedAt ? new Date(channel.lastScrapedAt).getTime() : 0;
            const elapsed = now.getTime() - lastScrape;
            if (elapsed >= channel.scrapTimeout && !this.inFlight.has(channel.id) && !this.jobQueue.some(j => j.channelId === channel.id)) {
                toScrape.push(channel);
                this.jobQueue.push({ channelId: channel.id, username: channel.link.split('/').pop() || '' });
            }
        }
        if (toScrape.length > 0) {
            await prisma.$transaction(
                toScrape.map(ch => prisma.channel.update({ where: { id: ch.id }, data: { lastScrapedAt: now } }))
            );
            await this.refreshChannelCache();
        }
        while (this.jobQueue.length > 0 && this.getIdleWorker()) {
            this.dispatchNext();
        }
    }

    private async processMessages(channelId: number, messages: ScrapedMessage[]) {
        const { emitAlerts } = await import('./alertBus');

        const channelInfo = this.channelCache.get(channelId);
        if (!channelInfo) return;
        const channelName = channelInfo.name || channelInfo.link || 'Alert';

        const subscribers = await prisma.user.findMany({
            where: { subscribedTo: { some: { id: channelId } }, silentMode: false }
        });

        const rules = this.rulesCache;
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

            const postTime = msg.date.toLocaleTimeString('uk-UA', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Kyiv'
            });
            const escapedText = esc(cleanedText);
            const quotedText = escapedText.split('\n').map(line => `>${line}`).join('\n');
            const outMessage = `🔔 *${escapedName}*\n${quotedText}\n\n🕒 \`${esc(postTime)}\``;
            prepared.push({ outMessage, mediaUrl: msg.mediaUrl, mediaType: msg.mediaType, telegramId: msg.telegramId });
        }

        // 5. PERSIST first (scraper is independent of Telegram)
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

        // 6. EMIT alerts for sender to deliver (non-blocking; scraper does not wait)
        if (prepared.length > 0 && subscribers.length > 0) {
            emitAlerts({
                channelId,
                channelName,
                items: prepared.map(p => ({ outMessage: p.outMessage, mediaUrl: p.mediaUrl, mediaType: p.mediaType, telegramId: p.telegramId })),
                subscriberIds: subscribers.map(s => s.telegramId)
            });
            prepared.forEach(p => logger.info(`🚨 Alert queued for ${p.telegramId}`, channelId));
        }
    }
}
