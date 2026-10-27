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
import { handleIncomingPost, type IncomingMessage } from './messageProcessor';
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

/** All channel messages flow through `inbound$`. Scrape and MTProto only enqueue here. */
export class ChannelFeed {
    /** Highest post id already taken into the pipe (persist / dedupe). */
    private lastIngestedPostId: number;
    /** Highest post id we already sent an alert for. */
    private lastNotifiedPostId: number;
    private readonly inbound$ = new Subject<IncomingMessage>();
    private pipeSub: Subscription | null = null;
    private scrapeSub: Subscription | null = null;

    constructor(
        private readonly meta: ChannelFeedMeta,
        initialPostId: number,
        private readonly runScrape: (afterTelegramId: number) => Observable<IncomingMessage[]>,
        private readonly schedule: ScrapeScheduleContext
    ) {
        this.lastIngestedPostId = initialPostId;
        this.lastNotifiedPostId = initialPostId;
        feeds.set(meta.channelId, this);
    }

    getLastIngestedPostId(): number {
        return this.lastIngestedPostId;
    }

    /** MTProto (and anything else) puts messages on the same inbound stream. */
    push(messages: IncomingMessage[]): void {
        const sorted = [...messages].sort((a, b) => a.telegramId - b.telegramId);
        for (const msg of sorted) this.inbound$.next(msg);
    }

    async start(): Promise<void> {
        if (this.pipeSub) return;
        await this.loadCursorsFromDb();
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
        const [allMax, sentMax] = await Promise.all([
            prisma.message.aggregate({
                where: { channelId },
                _max: { telegramId: true }
            }),
            prisma.message.aggregate({
                where: { channelId, sent: true },
                _max: { telegramId: true }
            })
        ]);
        const ingested = allMax._max.telegramId != null ? Number(allMax._max.telegramId) : this.lastIngestedPostId;
        const notified =
            sentMax._max.telegramId != null ? Number(sentMax._max.telegramId) : this.lastNotifiedPostId;
        this.lastIngestedPostId = Math.max(this.lastIngestedPostId, ingested);
        this.lastNotifiedPostId = Math.max(this.lastNotifiedPostId, notified);
    }

    /** Single pipe: every source → dedupe by post id → persist → notify only if newer than last alert. */
    private startMessagePipe(): void {
        this.pipeSub = this.inbound$
            .pipe(
                filter(msg => msg.telegramId > this.lastIngestedPostId),
                tap(msg => {
                    this.lastIngestedPostId = msg.telegramId;
                }),
                withLatestFrom(rules$),
                concatMap(([msg, rules]) => {
                    const shouldNotify = msg.telegramId > this.lastNotifiedPostId;
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
                            if (notified) this.lastNotifiedPostId = msg.telegramId;
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
                    return this.runScrape(this.lastIngestedPostId).pipe(
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
