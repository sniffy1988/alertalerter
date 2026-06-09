import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor, type IncomingMessage } from './messageProcessor';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    private static readonly POOL_SIZE = Math.min(8, Math.max(1, 2 * os.cpus().length));
    private static readonly FAILURE_BACKOFF_MS = 500;
    private static readonly MIN_SLEEP_MS = 50;
    private static readonly IDLE_SLEEP_MS = 60_000;

    constructor(
        intervalSeconds: number = 0.2,
        private readonly processor: MessageProcessor,
        options: ScraperOptions = {}
    ) {
        this.intervalSeconds = intervalSeconds;
        this.enabled = options.enabled ?? (() => true);
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(
            `Scraper ready (pool ${Scraper.POOL_SIZE}, poll ${this.intervalSeconds * 1000}ms, parallel with MTProto)`
        );

        await this.refreshChannelCache();
        this.initPool();

        while (this.isRunning) {
            if (this.enabled()) {
                try {
                    await this.triggerScrapeCycle();
                } catch (error) {
                    logger.error('Error during scrape cycle:', undefined, { error });
                }
                await delay(this.computeSleepMs());
            } else {
                await delay(Scraper.IDLE_SLEEP_MS);
            }
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
            this.replacePoolWorker(entry);
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
            this.replacePoolWorker(entry);
            this.scheduleNextCycle();
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
