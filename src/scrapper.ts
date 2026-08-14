import path from 'path';
import { Worker } from 'worker_threads';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor, type IncomingMessage } from './messageProcessor';
import { getPreferredHost, probeTelegramWebScrape } from './telegramWebScrape';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface WorkerResult {
    success: boolean;
    channelId: number;
    username: string;
    messages?: IncomingMessage[];
    maxTelegramId?: number;
    error?: any;
}

export type AddedChannel = {
    id: number;
    link: string;
    scrapTimeout: number;
    name: string | null;
};

type CachedChannel = AddedChannel & {
    lastSeenTelegramId?: number;
};

type ChannelRunner = {
    worker: Worker;
    channel: CachedChannel;
    stopping: boolean;
};

let activeScraper: Scraper | null = null;

export function notifyScraperChannelAdded(channel: AddedChannel): void {
    activeScraper?.addChannel(channel);
}

function usernameFromLink(link: string): string {
    return link.split('/').pop() || '';
}

/** One long-lived worker per channel; each polls on its own scrapTimeout. */
export class Scraper {
    private isRunning = false;
    private runners = new Map<number, ChannelRunner>();
    private channelCache = new Map<number, CachedChannel>();
    private probed = false;
    private lastScrapeAt = 0;
    private static readonly CACHE_REFRESH_MS = 15_000;

    constructor(private readonly processor: MessageProcessor) {
        activeScraper = this;
    }

    isPoolActive(): boolean {
        return this.runners.size > 0;
    }

    getHealth() {
        return {
            channelCount: this.channelCache.size,
            scrapeActive: this.runners.size > 0,
            workers: this.runners.size,
            lastScrapeAt: this.lastScrapeAt > 0 ? new Date(this.lastScrapeAt).toISOString() : null,
            channels: [...this.channelCache.values()].map(channel => ({
                id: channel.id,
                username: usernameFromLink(channel.link),
                intervalMs: channel.scrapTimeout,
                running: this.runners.has(channel.id)
            }))
        };
    }

    addChannel(channel: AddedChannel): void {
        const prev = this.channelCache.get(channel.id);
        const cached: CachedChannel = {
            ...channel,
            lastSeenTelegramId: prev?.lastSeenTelegramId
        };
        this.channelCache.set(channel.id, cached);
        if (this.isRunning) this.ensureRunner(cached);
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info('Scraper ready (1 worker per channel)');

        await this.ensureWebProbe();
        await this.refreshChannelCache();
        this.syncRunners();

        while (this.isRunning) {
            await delay(Scraper.CACHE_REFRESH_MS);
            try {
                await this.refreshChannelCache();
                this.syncRunners();
            } catch (error) {
                logger.error('Failed to refresh channel cache:', undefined, { error });
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

    private syncRunners(): void {
        for (const channel of this.channelCache.values()) {
            this.ensureRunner(channel);
        }
        for (const channelId of [...this.runners.keys()]) {
            if (!this.channelCache.has(channelId)) this.stopRunner(channelId);
        }
    }

    private ensureRunner(channel: CachedChannel): void {
        const existing = this.runners.get(channel.id);
        if (existing) {
            const prevTimeout = existing.channel.scrapTimeout;
            const prevUsername = usernameFromLink(existing.channel.link);
            existing.channel = channel;
            const username = usernameFromLink(channel.link);
            if (prevTimeout !== channel.scrapTimeout || prevUsername !== username) {
                existing.worker.postMessage({
                    type: 'config',
                    username,
                    scrapTimeout: channel.scrapTimeout,
                    afterTelegramId: channel.lastSeenTelegramId
                });
                if (prevTimeout !== channel.scrapTimeout) {
                    logger.info(`Channel interval now ${channel.scrapTimeout}ms`, channel.id, { username });
                }
            }
            return;
        }
        this.startRunner(channel);
    }

    private startRunner(channel: CachedChannel): void {
        const isTS = __filename.endsWith('.ts');
        const username = usernameFromLink(channel.link);
        const worker = new Worker(this.getWorkerPath(), {
            execArgv: isTS ? ['-r', 'ts-node/register'] : [],
            workerData: {
                isTS,
                preferredHost: getPreferredHost(),
                channelId: channel.id,
                username,
                scrapTimeout: channel.scrapTimeout,
                afterTelegramId: channel.lastSeenTelegramId
            }
        });
        const runner: ChannelRunner = { worker, channel, stopping: false };
        this.runners.set(channel.id, runner);

        worker.on('message', (result: WorkerResult) => this.handleWorkerResult(result));
        worker.on('error', (err) => {
            logger.error(`Channel worker crash @${username}`, channel.id, { error: err });
        });
        worker.on('exit', (code) => {
            if (code !== 0 && !runner.stopping) {
                logger.warn(`Channel worker exited with code ${code}`, channel.id, { username });
            }
            this.runners.delete(channel.id);
            if (!runner.stopping && this.isRunning && this.channelCache.has(channel.id)) {
                const latest = this.channelCache.get(channel.id)!;
                this.startRunner(latest);
            }
        });

        logger.info(`Channel worker started @${username} every ${channel.scrapTimeout}ms`, channel.id);
    }

    private stopRunner(channelId: number): void {
        const runner = this.runners.get(channelId);
        if (!runner) return;
        runner.stopping = true;
        this.runners.delete(channelId);
        void runner.worker.terminate();
        logger.info('Channel worker stopped', channelId, {
            username: usernameFromLink(runner.channel.link)
        });
    }

    private handleWorkerResult(result: WorkerResult) {
        if (result.success && result.messages) {
            this.lastScrapeAt = Date.now();
            const cached = this.channelCache.get(result.channelId);
            if (cached && result.maxTelegramId != null) {
                cached.lastSeenTelegramId = Math.max(cached.lastSeenTelegramId ?? 0, result.maxTelegramId);
            }

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
            logger.error(`Worker error for ${result.username}:`, result.channelId, { error: result.error });
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
                lastSeenTelegramId: prev?.lastSeenTelegramId ?? maxByChannel.get(channel.id)
            });
        }
        this.channelCache = next;
    }

    private getWorkerPath(): string {
        const isTS = __filename.endsWith('.ts');
        const workerExt = isTS ? '.ts' : '.js';
        return path.resolve(__dirname, `./scraper.worker${workerExt}`);
    }
}
