import {
    catchError,
    concatMap,
    defer,
    EMPTY,
    exhaustMap,
    filter,
    from,
    Observable,
    repeat,
    Subject,
    Subscription,
    tap,
    timer,
    withLatestFrom
} from 'rxjs';
import prisma from './db';
import { logger } from './logger';
import { fetchSubscriberIds, handleIncomingPost, type IncomingMessage } from './messageProcessor';
import { rules$ } from './rules';

export type ChannelFeedMeta = {
    channelId: number;
    channelName: string;
};

export type ScrapeScheduleContext = {
    msUntilDue: () => number;
    onScrapeStart: () => void;
    onScrapeSuccess: (messages: IncomingMessage[]) => void;
    onScrapeFailure: (error: unknown) => void;
};

const feeds = new Map<number, ChannelFeed>();

export function getChannelFeed(channelId: number): ChannelFeed | undefined {
    return feeds.get(channelId);
}

const MAP_INGEST_SOURCE = 'tlk-map';

/** All channel messages flow through `inbound$`. Scrape and MTProto only enqueue here. */
export class ChannelFeed {
    /** Cursor for t.me scrape (`afterTelegramId`); only moves on non-map ingest. */
    private scrapeAfterId: number;
    private readonly ingestedPostIds = new Set<number>();
    private readonly notifiedPostIds = new Set<number>();
    private readonly inbound$ = new Subject<IncomingMessage>();
    private pipeSub: Subscription | null = null;
    private scrapeSub: Subscription | null = null;

    constructor(
        private readonly meta: ChannelFeedMeta,
        initialPostId: number,
        private readonly runScrape: (afterTelegramId: number) => Observable<IncomingMessage[]>,
        private readonly schedule: ScrapeScheduleContext
    ) {
        this.scrapeAfterId = initialPostId;
        feeds.set(meta.channelId, this);
    }

    getLastIngestedPostId(): number {
        return this.scrapeAfterId;
    }

    /** MTProto (and anything else) puts messages on the same inbound stream. */
    push(messages: IncomingMessage[]): void {
        const sorted = [...messages].sort((a, b) => a.telegramId - b.telegramId);
        for (const msg of sorted) this.inbound$.next(msg);
    }

    async start(): Promise<void> {
        if (this.pipeSub) return;
        await this.loadCursorsFromDb();
        await fetchSubscriberIds(this.meta.channelId).catch(err => {
            logger.warn('Subscriber cache warm failed', this.meta.channelId, { error: err });
        });
        this.startMessagePipe();
        this.startScrapeScheduler();
    }

    stop(): void {
        this.pipeSub?.unsubscribe();
        this.scrapeSub?.unsubscribe();
        this.pipeSub = null;
        this.scrapeSub = null;
        feeds.delete(this.meta.channelId);
    }

    private async loadCursorsFromDb(): Promise<void> {
        const channelId = this.meta.channelId;
        const [allMax, ingestedRows, notifiedRows] = await Promise.all([
            prisma.message.aggregate({
                where: { channelId },
                _max: { telegramId: true }
            }),
            prisma.message.findMany({
                where: { channelId },
                select: { telegramId: true }
            }),
            prisma.message.findMany({
                where: { channelId, sent: true },
                select: { telegramId: true }
            })
        ]);
        for (const row of ingestedRows) {
            this.ingestedPostIds.add(Number(row.telegramId));
        }
        for (const row of notifiedRows) {
            this.notifiedPostIds.add(Number(row.telegramId));
        }
        const ingested =
            allMax._max.telegramId != null ? Number(allMax._max.telegramId) : this.scrapeAfterId;
        this.scrapeAfterId = Math.max(this.scrapeAfterId, ingested);
    }

    private isMapSource(msg: IncomingMessage): boolean {
        return msg.source === MAP_INGEST_SOURCE;
    }

    /** Single pipe: every source → dedupe by post id → persist → notify per post id. */
    private startMessagePipe(): void {
        this.pipeSub = this.inbound$
            .pipe(
                filter(msg => !this.ingestedPostIds.has(msg.telegramId)),
                tap(msg => {
                    this.ingestedPostIds.add(msg.telegramId);
                    if (!this.isMapSource(msg)) {
                        this.scrapeAfterId = Math.max(this.scrapeAfterId, msg.telegramId);
                    }
                }),
                withLatestFrom(rules$),
                concatMap(([msg, rules]) => {
                    const shouldNotify = !this.notifiedPostIds.has(msg.telegramId);
                    return from(
                        handleIncomingPost(
                            this.meta.channelId,
                            this.meta.channelName,
                            msg,
                            rules,
                            shouldNotify
                        )
                    ).pipe(
                        tap(notified => {
                            if (notified) this.notifiedPostIds.add(msg.telegramId);
                        }),
                        catchError(err => {
                            logger.error('Channel feed handle post failed', this.meta.channelId, {
                                telegramId: msg.telegramId,
                                error: err
                            });
                            return EMPTY;
                        })
                    );
                })
            )
            .subscribe();
    }

    /** Scrape timing loop only: fetch pages and enqueue messages on `inbound$`. */
    private startScrapeScheduler(): void {
        this.scrapeSub = defer(() => timer(this.schedule.msUntilDue()))
            .pipe(
                exhaustMap(() => {
                    this.schedule.onScrapeStart();
                    return this.runScrape(this.scrapeAfterId).pipe(
                        tap(msgs => this.push(msgs.map(m => ({ ...m, source: m.source || 't.me' })))),
                        tap(msgs => this.schedule.onScrapeSuccess(msgs)),
                        catchError(err => {
                            this.schedule.onScrapeFailure(err);
                            logger.error('Scrape failed', this.meta.channelId, { error: err });
                            return EMPTY;
                        })
                    );
                }),
                repeat()
            )
            .subscribe();
    }
}
