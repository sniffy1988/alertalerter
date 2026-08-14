import path from 'path';
import { Worker } from 'worker_threads';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor, type IncomingMessage } from './messageProcessor';
import { getPreferredHost, probeTelegramWebScrape } from './telegramWebScrape';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parsePoolSize(): number {
    const n = Number(process.env.SCRAPER_POOL_SIZE);
    if (Number.isFinite(n) && n >= 1) return Math.min(16, Math.floor(n));
    return 4;
}

interface WorkerResult {
    success: boolean;
    channelId: number;
    username: string;
    messages?: IncomingMessage[];
    maxTelegramId?: number;
    error?: any;
    log?: string;
}

interface ScrapeJob {
    channelId: number;
    username: string;
    afterTelegramId?: number;
}

export type AddedChannel = {
    id: number;
    link: string;
    scrapTimeout: number;
    name: string | null;
};

type PoolEntry = { worker: Worker; busy: boolean; currentJob?: ScrapeJob };

type CachedChannel = AddedChannel & {
    lastScrapedAt: Date | null;
    lastSeenTelegramId?: number;
};

let activeScraper: Scraper | null = null;

export function notifyScraperChannelAdded(channel: AddedChannel): void {
    activeScraper?.addChannel(channel);
}

/** Worker pool with job queue; each channel has its own scrapTimeout (ms) from DB. */
export class Scraper {
    private isRunning = false;
    private intervalSeconds: number;
    private pool: PoolEntry[] = [];
    private jobQueue: ScrapeJob[] = [];
    private inFlight = new Set<number>();
    private channelCache = new Map<number, CachedChannel>();
    private failureBackoffUntil = new Map<number, number>();
    private failureStreak = new Map<number, number>();
    private probed = false;
    private lastCacheRefreshAt = 0;
    private lastScrapeAt = 0;
    private readonly poolSize: number;
    private static readonly MIN_SLEEP_MS = 50;
    private static readonly CACHE_REFRESH_MS = 15_000;
    private static readonly FAILURE_BACKOFF_START_MS = 1_000;
    private static readonly FAILURE_BACKOFF_CAP_MS = 30_000;

    constructor(
        intervalSeconds: number = 0.2,
        private readonly processor: MessageProcessor
    ) {
        this.intervalSeconds = intervalSeconds;
        this.poolSize = parsePoolSize();
        activeScraper = this;
    }

    isPoolActive(): boolean {
        return this.pool.length > 0;
    }

    getHealth() {
        return {
            channelCount: this.channelCache.size,
            scrapeActive: this.isPoolActive(),
            poolSize: this.poolSize,
            lastScrapeAt: this.lastScrapeAt > 0 ? new Date(this.lastScrapeAt).toISOString() : null
        };
    }

    addChannel(channel: AddedChannel): void {
        const prev = this.channelCache.get(channel.id);
        this.channelCache.set(channel.id, {
            ...channel,
            lastScrapedAt: prev?.lastScrapedAt ?? null,
            lastSeenTelegramId: prev?.lastSeenTelegramId
        });
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(
            `Scraper ready (pool ${this.poolSize}, poll ${this.intervalSeconds * 1000}ms)`
        );

        await this.refreshChannelCache();

        while (this.isRunning) {
            await this.ensureWebProbe();
            this.ensurePool();
            if (Date.now() - this.lastCacheRefreshAt >= Scraper.CACHE_REFRESH_MS) {
                try {
                    await this.refreshChannelCache();
                } catch (error) {
                    logger.error('Failed to refresh channel cache:', undefined, { error });
                }
            }
            try {
                await this.triggerScrapeCycle();
            } catch (error) {
                logger.error('Error during scrape cycle:', undefined, { error });
            }
            await delay(this.computeSleepMs());
        }
    }

    private async ensureWebProbe(): Promise<void> {
        if (this.probed) return;
        this.probed = true;
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
    }

    private ensurePool(): void {
        if (this.pool.length > 0) return;
        logger.info(`Scraper workers starting (${this.poolSize})`);
        for (let i = 0; i < this.poolSize; i++) {
            this.pool.push(this.createPoolWorker());
        }
    }

    private computeSleepMs(): number {
        const now = Date.now();
        const pollMs = this.intervalSeconds * 1000;
        let msUntilNextDue = pollMs;

        for (const channel of this.channelCache.values()) {
            const lastScrape = channel.lastScrapedAt ? new Date(channel.lastScrapedAt).getTime() : 0;
            const remaining = channel.scrapTimeout - (now - lastScrape);
            if (remaining <= 0) return Scraper.MIN_SLEEP_MS;
            msUntilNextDue = Math.min(msUntilNextDue, remaining);
        }

        return Math.max(Scraper.MIN_SLEEP_MS, Math.min(pollMs, msUntilNextDue));
    }

    private scheduleNextCycle(): void {
        if (!this.isRunning) return;
        void this.triggerScrapeCycle().catch(error =>
            logger.error('Error during scheduled scrape cycle:', undefined, { error })
        );
    }

    private markScrapeSuccess(channelId: number, maxTelegramId?: number): void {
        const now = Date.now();
        this.lastScrapeAt = now;
        const cached = this.channelCache.get(channelId);
        if (!cached) return;
        cached.lastScrapedAt = new Date(now);
        if (maxTelegramId != null) {
            cached.lastSeenTelegramId = Math.max(cached.lastSeenTelegramId ?? 0, maxTelegramId);
        }
        this.failureStreak.delete(channelId);
        this.failureBackoffUntil.delete(channelId);
    }

    private markScrapeFailure(channelId: number): void {
        const streak = (this.failureStreak.get(channelId) ?? 0) + 1;
        this.failureStreak.set(channelId, streak);
        const backoffMs = Math.min(
            Scraper.FAILURE_BACKOFF_CAP_MS,
            Scraper.FAILURE_BACKOFF_START_MS * 2 ** (streak - 1)
        );
        this.failureBackoffUntil.set(channelId, Date.now() + backoffMs);
    }

    private handleWorkerResult(entry: PoolEntry, result: WorkerResult) {
        this.inFlight.delete(result.channelId);
        entry.busy = false;
        entry.currentJob = undefined;

        if (result.success && result.messages) {
            this.markScrapeSuccess(result.channelId, result.maxTelegramId);

            void this.processor.processIncomingMessages(result.channelId, result.messages)
                .then(({ persisted }) => {
                    if (persisted > 0) {
                        logger.info(`Scrape ingested ${persisted} new message(s)`, result.channelId, {
                            username: result.username,
                            fetched: result.messages!.length
                        });
                    } else {
                        logger.debug('Scrape cycle: no new messages', result.channelId, {
                            username: result.username,
                            fetched: result.messages!.length
                        });
                    }
                })
                .catch(err =>
                    logger.error('processMessages error', result.channelId, { error: err })
                );
        } else if (result.error) {
            this.markScrapeFailure(result.channelId);
            logger.error(`Worker error for ${result.username}:`, result.channelId, { error: result.error });
        }

        this.dispatchNext();
    }

    private async refreshChannelCache() {
        const channels = await prisma.channel.findMany({
            select: { id: true, link: true, scrapTimeout: true, name: true }
        });

        const missingSeenIds = channels
            .filter(c => this.channelCache.get(c.id)?.lastSeenTelegramId == null)
            .map(c => c.id);

        const maxByChannel = new Map<number, number>();
        if (missingSeenIds.length > 0) {
            const rows = await prisma.message.groupBy({
                by: ['channelId'],
                where: { channelId: { in: missingSeenIds } },
                _max: { telegramId: true }
            });
            for (const row of rows) {
                if (row._max.telegramId != null) {
                    maxByChannel.set(row.channelId, Number(row._max.telegramId));
                }
            }
        }

        const next = new Map<number, CachedChannel>();
        for (const channel of channels) {
            const prev = this.channelCache.get(channel.id);
            next.set(channel.id, {
                ...channel,
                lastScrapedAt: prev?.lastScrapedAt ?? null,
                lastSeenTelegramId: prev?.lastSeenTelegramId ?? maxByChannel.get(channel.id)
            });
        }
        this.channelCache = next;
        this.lastCacheRefreshAt = Date.now();
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
            workerData: { isTS, preferredHost: getPreferredHost() }
        });
        const entry: PoolEntry = { worker, busy: false };

        worker.on('message', (result: WorkerResult) => this.handleWorkerResult(entry, result));
        worker.on('error', (err) => {
            logger.error('Worker crash', undefined, { error: err });
            if (entry.currentJob) {
                this.inFlight.delete(entry.currentJob.channelId);
                this.markScrapeFailure(entry.currentJob.channelId);
            }
            entry.busy = false;
            entry.currentJob = undefined;
            this.removeFromPool(entry);
            this.replacePoolWorker();
            this.scheduleNextCycle();
        });
        worker.on('exit', (code) => {
            if (code !== 0) logger.warn(`Worker exited with code ${code}`);
            if (entry.currentJob) {
                this.inFlight.delete(entry.currentJob.channelId);
                this.markScrapeFailure(entry.currentJob.channelId);
            }
            entry.busy = false;
            entry.currentJob = undefined;
            this.removeFromPool(entry);
            this.replacePoolWorker();
            this.scheduleNextCycle();
        });

        return entry;
    }

    private removeFromPool(entry: PoolEntry) {
        const i = this.pool.indexOf(entry);
        if (i !== -1) this.pool.splice(i, 1);
    }

    private replacePoolWorker() {
        if (!this.isRunning) return;
        if (this.pool.length >= this.poolSize) return;
        this.pool.push(this.createPoolWorker());
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
        const now = Date.now();
        const channels = Array.from(this.channelCache.values());

        for (const channel of channels) {
            const backoffUntil = this.failureBackoffUntil.get(channel.id) ?? 0;
            if (now < backoffUntil) continue;

            const lastScrape = channel.lastScrapedAt ? new Date(channel.lastScrapedAt).getTime() : 0;
            const elapsed = now - lastScrape;
            if (
                elapsed >= channel.scrapTimeout &&
                !this.inFlight.has(channel.id) &&
                !this.jobQueue.some(j => j.channelId === channel.id)
            ) {
                this.jobQueue.push({
                    channelId: channel.id,
                    username: channel.link.split('/').pop() || '',
                    afterTelegramId: channel.lastSeenTelegramId
                });
            }
        }

        while (this.jobQueue.length > 0 && this.getIdleWorker()) {
            this.dispatchNext();
        }
    }
}
