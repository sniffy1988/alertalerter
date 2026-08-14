import path from 'path';
import { Worker } from 'worker_threads';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor, type IncomingMessage } from './messageProcessor';
import { probeTelegramWebScrape } from './telegramWebScrape';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parsePoolSize(): number {
    const n = Number(process.env.SCRAPER_POOL_SIZE);
    if (Number.isFinite(n) && n >= 1) return Math.min(8, Math.floor(n));
    return 2;
}

interface WorkerResult {
    success: boolean;
    channelId: number;
    username: string;
    messages?: IncomingMessage[];
    error?: any;
    log?: string;
}

interface ScrapeJob {
    channelId: number;
    username: string;
}

type PoolEntry = { worker: Worker; busy: boolean; currentJob?: ScrapeJob };

type CachedChannel = { id: number; link: string; lastScrapedAt: Date | null; scrapTimeout: number; name: string | null };

export type ScraperOptions = {
    /** When false, scraper idles (MTProto-only mode). Default: always run. */
    enabled?: () => boolean;
};

/** Worker pool with job queue; each channel has its own scrapTimeout (ms) from DB. */
export class Scraper {
    private isRunning = false;
    private intervalSeconds: number;
    private pool: PoolEntry[] = [];
    private jobQueue: ScrapeJob[] = [];
    private inFlight = new Set<number>();
    private channelCache = new Map<number, CachedChannel>();
    private failureBackoffUntil = new Map<number, number>();
    private enabled: () => boolean;
    private shuttingDownPool = false;
    private poolWanted = false;
    private probed = false;
    private readonly poolSize: number;
    private static readonly FAILURE_BACKOFF_MS = 500;
    private static readonly MIN_SLEEP_MS = 50;
    private static readonly IDLE_SLEEP_MS = 5_000;

    constructor(
        intervalSeconds: number = 0.2,
        private readonly processor: MessageProcessor,
        options: ScraperOptions = {}
    ) {
        this.intervalSeconds = intervalSeconds;
        this.enabled = options.enabled ?? (() => true);
        this.poolSize = parsePoolSize();
    }

    isPoolActive(): boolean {
        return this.pool.length > 0;
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(
            `Scraper ready (pool ${this.poolSize}, poll ${this.intervalSeconds * 1000}ms, fallback when MTProto idle)`
        );

        await this.refreshChannelCache();

        while (this.isRunning) {
            if (this.enabled()) {
                await this.ensureWebProbe();
                this.ensurePool();
                try {
                    await this.triggerScrapeCycle();
                } catch (error) {
                    logger.error('Error during scrape cycle:', undefined, { error });
                }
                await delay(this.computeSleepMs());
            } else {
                await this.destroyPool();
                await delay(Scraper.IDLE_SLEEP_MS);
            }
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
        if (this.pool.length > 0 || this.shuttingDownPool) return;
        this.poolWanted = true;
        logger.info(`Scraper workers starting (${this.poolSize})`);
        void this.refreshChannelCache();
        for (let i = 0; i < this.poolSize; i++) {
            this.pool.push(this.createPoolWorker());
        }
    }

    private async destroyPool(): Promise<void> {
        if (this.pool.length === 0 && !this.poolWanted) return;
        this.poolWanted = false;
        this.shuttingDownPool = true;
        const entries = [...this.pool];
        this.pool = [];
        this.jobQueue = [];
        this.inFlight.clear();
        await Promise.all(entries.map(e => e.worker.terminate().catch(() => 0)));
        this.shuttingDownPool = false;
        if (entries.length > 0) {
            logger.info('Scraper workers stopped (MTProto healthy)');
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
        if (!this.enabled()) return;
        void this.triggerScrapeCycle().catch(error =>
            logger.error('Error during scheduled scrape cycle:', undefined, { error })
        );
    }

    private markScrapeSuccess(channelId: number): void {
        const now = new Date();
        const cached = this.channelCache.get(channelId);
        if (cached) {
            cached.lastScrapedAt = now;
        }
        void prisma.channel.update({
            where: { id: channelId },
            data: { lastScrapedAt: now }
        }).catch(err =>
            logger.error('Failed to update lastScrapedAt', channelId, { error: err })
        );
    }

    private handleWorkerResult(entry: PoolEntry, result: WorkerResult) {
        this.inFlight.delete(result.channelId);
        entry.busy = false;
        entry.currentJob = undefined;

        if (result.success && result.messages) {
            this.failureBackoffUntil.delete(result.channelId);
            this.markScrapeSuccess(result.channelId);

            void this.processor.processIncomingMessages(result.channelId, result.messages, 'scrape')
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
            this.failureBackoffUntil.set(result.channelId, Date.now() + Scraper.FAILURE_BACKOFF_MS);
            logger.error(`Worker error for ${result.username}:`, result.channelId, { error: result.error });
        }

        this.dispatchNext();
    }

    private async refreshChannelCache() {
        const channels = await prisma.channel.findMany({
            select: { id: true, link: true, lastScrapedAt: true, scrapTimeout: true, name: true }
        });
        this.channelCache = new Map(channels.map(c => [c.id, c]));
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
            if (entry.currentJob) {
                this.inFlight.delete(entry.currentJob.channelId);
                this.failureBackoffUntil.set(
                    entry.currentJob.channelId,
                    Date.now() + Scraper.FAILURE_BACKOFF_MS
                );
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
                this.failureBackoffUntil.set(
                    entry.currentJob.channelId,
                    Date.now() + Scraper.FAILURE_BACKOFF_MS
                );
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
        if (this.shuttingDownPool || !this.poolWanted || !this.isRunning || !this.enabled()) return;
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
                    username: channel.link.split('/').pop() || ''
                });
            }
        }

        while (this.jobQueue.length > 0 && this.getIdleWorker()) {
            this.dispatchNext();
        }
    }
}
