import path from 'path';
import { Worker } from 'worker_threads';
import { exhaustMap, from, interval, Observable, Subscription } from 'rxjs';
import prisma from './db';
import { logger } from './logger';
import { type IncomingMessage } from './messageProcessor';
import { ChannelFeed } from './channelFeed';
import { getPreferredHost, probeTelegramWebScrape } from './telegramWebScrape';

interface WorkerResult {
    success: boolean;
    channelId: number;
    username: string;
    messages?: IncomingMessage[];
    maxTelegramId?: number;
    hasMore?: boolean;
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

type ChannelWorker = {
    worker: Worker;
    busy: boolean;
    channelId: number;
    stopped: boolean;
};

type CachedChannel = AddedChannel & {
    lastScrapedAt: Date | null;
    lastSeenTelegramId?: number;
};

let activeScraper: Scraper | null = null;

export function notifyScraperChannelAdded(channel: AddedChannel): void {
    activeScraper?.addChannel(channel);
}

/** One scrape worker and one RxJS feed per channel. */
export class Scraper {
    private isRunning = false;
    private workers = new Map<number, ChannelWorker>();
    private feeds = new Map<number, ChannelFeed>();
    private channelCache = new Map<number, CachedChannel>();
    private failureBackoffUntil = new Map<number, number>();
    private failureStreak = new Map<number, number>();
    private probed = false;
    private lastCacheRefreshAt = 0;
    private lastScrapeAt = 0;
    private refreshSub: Subscription | null = null;
    private static readonly MIN_SLEEP_MS = 50;
    private static readonly CACHE_REFRESH_MS = 15_000;
    private static readonly FAILURE_BACKOFF_START_MS = 500;
    private static readonly FAILURE_BACKOFF_CAP_MS = 5_000;

    constructor() {
        activeScraper = this;
    }

    isScrapeActive(): boolean {
        return this.workers.size > 0;
    }

    getHealth() {
        return {
            channelCount: this.channelCache.size,
            scrapeActive: this.isScrapeActive(),
            workerCount: this.workers.size,
            lastScrapeAt: this.lastScrapeAt > 0 ? new Date(this.lastScrapeAt).toISOString() : null
        };
    }

    addChannel(channel: AddedChannel): void {
        const prev = this.channelCache.get(channel.id);
        const cached: CachedChannel = {
            ...channel,
            lastScrapedAt: prev?.lastScrapedAt ?? null,
            lastSeenTelegramId: prev?.lastSeenTelegramId
        };
        this.channelCache.set(channel.id, cached);
        if (this.isRunning && this.probed) {
            this.ensureChannelWorker(cached);
            this.ensureChannelFeed(cached);
        }
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info('Scraper ready (one worker and one stream per channel)');

        await this.ensureWebProbe();
        await this.refreshChannelCache();
        this.syncWorkers();
        this.syncFeeds();

        this.refreshSub = interval(this.cacheRefreshIntervalMs())
            .pipe(
                exhaustMap(() =>
                    from(
                        this.refreshChannelCache()
                            .then(() => {
                                this.syncWorkers();
                                this.syncFeeds();
                            })
                            .catch(error => {
                                logger.error('Failed to refresh channel cache:', undefined, { error });
                            })
                    )
                )
            )
            .subscribe();
    }

    private async ensureWebProbe(): Promise<void> {
        if (this.probed) return;
        const webProbe = await probeTelegramWebScrape();
        this.probed = true;
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

    private markScrapeSuccess(channelId: number): void {
        this.lastScrapeAt = Date.now();
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

    private msUntilScrapeDue(channel: CachedChannel): number {
        const now = Date.now();
        const backoffUntil = this.failureBackoffUntil.get(channel.id) ?? 0;
        if (now < backoffUntil) return backoffUntil - now;
        const lastScrape = channel.lastScrapedAt ? channel.lastScrapedAt.getTime() : 0;
        const remaining = this.scrapeIntervalMs(channel) - (now - lastScrape);
        return Math.max(Scraper.MIN_SLEEP_MS, remaining);
    }

    private executeScrapeCycle(channel: CachedChannel, afterTelegramId: number): Observable<IncomingMessage[]> {
        return new Observable(subscriber => {
            const collected: IncomingMessage[] = [];

            const runPage = (afterId: number) => {
                const entry = this.workers.get(channel.id);
                if (!entry || entry.stopped) {
                    subscriber.next(collected);
                    subscriber.complete();
                    return;
                }

                const onMessage = (result: WorkerResult) => {
                    entry.worker.off('message', onMessage);
                    entry.busy = false;

                    if (!result.success) {
                        subscriber.error(result.error ?? new Error('Scrape failed'));
                        return;
                    }

                    const tagged = (result.messages ?? []).map(message => ({
                        ...message,
                        source: message.source || 't.me'
                    }));
                    collected.push(...tagged);

                    if (result.hasMore && result.maxTelegramId != null && !entry.stopped) {
                        runPage(result.maxTelegramId);
                        return;
                    }

                    subscriber.next(collected);
                    subscriber.complete();
                };

                entry.busy = true;
                channel.lastScrapedAt = new Date();
                const job: ScrapeJob = {
                    channelId: channel.id,
                    username: this.channelUsername(channel),
                    afterTelegramId: afterId
                };
                entry.worker.on('message', onMessage);
                entry.worker.postMessage(job);
            };

            runPage(afterTelegramId);
        });
    }

    private ensureChannelFeed(channel: CachedChannel): void {
        if (this.feeds.has(channel.id)) return;

        const channelName = channel.name || channel.link || 'Alert';
        const initialPostId = channel.lastSeenTelegramId ?? 0;
        const feed = new ChannelFeed(
            { channelId: channel.id, channelName },
            initialPostId,
            afterId => this.executeScrapeCycle(channel, afterId),
            {
                msUntilDue: () => this.msUntilScrapeDue(channel),
                onScrapeStart: () => {},
                onScrapeSuccess: fetched => {
                    this.markScrapeSuccess(channel.id);
                    if (fetched > 0) {
                        logger.debug('Scrape cycle complete', channel.id, {
                            username: this.channelUsername(channel),
                            fetched
                        });
                    }
                },
                onScrapeFailure: () => this.markScrapeFailure(channel.id)
            }
        );
        void feed.start().catch(err =>
            logger.error('Channel feed failed to start', channel.id, { error: err })
        );
        this.feeds.set(channel.id, feed);
        logger.info('Channel feed started', channel.id, { username: this.channelUsername(channel) });
    }

    private stopChannelFeed(channelId: number): void {
        const feed = this.feeds.get(channelId);
        if (!feed) return;
        feed.stop();
        this.feeds.delete(channelId);
    }

    private syncFeeds(): void {
        if (!this.probed) return;
        for (const channelId of this.feeds.keys()) {
            if (!this.channelCache.has(channelId)) this.stopChannelFeed(channelId);
        }
        for (const channel of this.channelCache.values()) {
            this.ensureChannelFeed(channel);
        }
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

    private channelUsername(channel: CachedChannel): string {
        return channel.link.split('/').pop() || '';
    }

    private ensureChannelWorker(channel: CachedChannel): ChannelWorker {
        const existing = this.workers.get(channel.id);
        if (existing) return existing;

        const isTS = __filename.endsWith('.ts');
        const worker = new Worker(this.getWorkerPath(), {
            execArgv: isTS ? ['-r', 'ts-node/register'] : [],
            workerData: { isTS, preferredHost: getPreferredHost() }
        });
        const entry: ChannelWorker = { worker, busy: false, channelId: channel.id, stopped: false };
        this.workers.set(channel.id, entry);
        logger.info('Scraper worker started', channel.id, { username: this.channelUsername(channel) });

        worker.on('error', err => {
            logger.error('Worker crash', channel.id, { error: err });
            if (entry.busy) {
                entry.busy = false;
                this.markScrapeFailure(channel.id);
            }
        });
        worker.on('exit', code => {
            if (entry.busy) {
                entry.busy = false;
                this.markScrapeFailure(channel.id);
            }
            if (entry.stopped || this.workers.get(channel.id) !== entry) return;
            if (code !== 0) logger.warn(`Worker exited with code ${code}`, channel.id);
            this.workers.delete(channel.id);
            if (!this.isRunning) return;
            const cached = this.channelCache.get(channel.id);
            if (!cached) return;
            this.ensureChannelWorker(cached);
        });

        return entry;
    }

    private stopChannelWorker(channelId: number): void {
        const entry = this.workers.get(channelId);
        if (!entry) return;
        entry.stopped = true;
        this.workers.delete(channelId);
        this.failureBackoffUntil.delete(channelId);
        this.failureStreak.delete(channelId);
        void entry.worker.terminate();
    }

    private syncWorkers(): void {
        if (!this.probed) return;
        for (const channelId of this.workers.keys()) {
            if (!this.channelCache.has(channelId)) this.stopChannelWorker(channelId);
        }
        for (const channel of this.channelCache.values()) {
            this.ensureChannelWorker(channel);
        }
    }

    private scrapeIntervalMs(channel: CachedChannel): number {
        const configured = Number(channel.scrapTimeout);
        if (!Number.isFinite(configured) || configured < Scraper.MIN_SLEEP_MS) return Scraper.MIN_SLEEP_MS;
        return configured;
    }

    private cacheRefreshIntervalMs(): number {
        let intervalMs = Scraper.CACHE_REFRESH_MS;
        for (const channel of this.channelCache.values()) {
            intervalMs = Math.min(intervalMs, this.scrapeIntervalMs(channel));
        }
        return intervalMs;
    }
}
