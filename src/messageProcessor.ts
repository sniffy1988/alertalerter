import prisma from './db';
import { logger } from './logger';
import { emitAlerts } from './alertBus';

export type IncomingMessage = {
    telegramId: number;
    text: string;
    mediaUrl?: string;
    mediaType?: 'photo' | 'video';
    date: Date;
    sender?: string;
    source?: string;
};

export function cleanMessage(text: string): string {
    return text
        .replace(/📷\s*TlkInst/gi, ' ')
        .replace(/🎞\s*Канал со стримами/gi, ' ')
        .replace(/✅ Підпишись на СХІ[ДD]/gi, ' ')
        .replace(/[’ʼ]/g, "'")
        .replace(/[^\S\r\n]+/g, ' ')
        .trim();
}

export function previewMessageText(text: string, max = 120): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function normalize(s: string): string {
    return s.toLowerCase().replace(/[’ʼ]/g, "'").trim();
}

function esc(text: string): string {
    return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
}

type CachedChannel = { name: string | null; link: string; expiresAt: number };
type CachedSubscribers = { ids: bigint[]; expiresAt: number };

export class MessageProcessor {
    private includeRules: string[] = [];
    private excludeRules: string[] = [];
    private lastRulesRefreshAt = 0;
    private recentlyEmitted = new Map<number, Map<string, number>>();
    private channelCache = new Map<number, CachedChannel>();
    private subscriberCache = new Map<number, CachedSubscribers>();
    private static readonly RULES_CACHE_TTL_MS = 60_000;
    private static readonly LOOKUP_CACHE_TTL_MS = 30_000;
    private static readonly RECENTLY_EMITTED_TTL_MS = 60_000;

    private async refreshRulesCache(): Promise<void> {
        const rules = await prisma.filterPhrase.findMany();
        this.includeRules = [];
        this.excludeRules = [];
        for (const r of rules) {
            const phrase = normalize(r.phrase);
            if (r.exclude) this.excludeRules.push(phrase);
            else this.includeRules.push(phrase);
        }
        this.lastRulesRefreshAt = Date.now();
    }

    private async ensureRulesFresh(): Promise<void> {
        if (Date.now() - this.lastRulesRefreshAt > MessageProcessor.RULES_CACHE_TTL_MS) {
            await this.refreshRulesCache();
        }
    }

    private isRecentlyEmitted(channelId: number, telegramId: number): boolean {
        const channelSet = this.recentlyEmitted.get(channelId);
        if (!channelSet) return false;

        const key = telegramId.toString();
        const expiresAt = channelSet.get(key);
        if (expiresAt == null) return false;

        if (Date.now() > expiresAt) {
            channelSet.delete(key);
            return false;
        }
        return true;
    }

    private markRecentlyEmitted(channelId: number, telegramId: number): void {
        let channelSet = this.recentlyEmitted.get(channelId);
        if (!channelSet) {
            channelSet = new Map();
            this.recentlyEmitted.set(channelId, channelSet);
        }
        channelSet.set(telegramId.toString(), Date.now() + MessageProcessor.RECENTLY_EMITTED_TTL_MS);
    }

    private claimIncoming(channelId: number, messages: IncomingMessage[]): IncomingMessage[] {
        const claimed: IncomingMessage[] = [];
        for (const msg of messages) {
            if (this.isRecentlyEmitted(channelId, msg.telegramId)) continue;
            this.markRecentlyEmitted(channelId, msg.telegramId);
            claimed.push(msg);
        }
        return claimed;
    }

    private releaseClaim(channelId: number, messages: IncomingMessage[]): void {
        const channelSet = this.recentlyEmitted.get(channelId);
        if (!channelSet) return;
        for (const msg of messages) channelSet.delete(msg.telegramId.toString());
    }

    private async getChannel(channelId: number): Promise<CachedChannel | null> {
        const cached = this.channelCache.get(channelId);
        if (cached && cached.expiresAt > Date.now()) return cached;

        const channel = await prisma.channel.findUnique({
            where: { id: channelId },
            select: { name: true, link: true }
        });
        if (!channel) return null;

        const entry: CachedChannel = {
            name: channel.name,
            link: channel.link,
            expiresAt: Date.now() + MessageProcessor.LOOKUP_CACHE_TTL_MS
        };
        this.channelCache.set(channelId, entry);
        return entry;
    }

    private async getSubscriberIds(channelId: number): Promise<bigint[]> {
        const cached = this.subscriberCache.get(channelId);
        if (cached && cached.expiresAt > Date.now()) return cached.ids;

        const users = await prisma.user.findMany({
            where: { subscribedTo: { some: { id: channelId } }, silentMode: false },
            select: { telegramId: true }
        });
        const ids = users.map(u => u.telegramId);
        this.subscriberCache.set(channelId, {
            ids,
            expiresAt: Date.now() + MessageProcessor.LOOKUP_CACHE_TTL_MS
        });
        return ids;
    }

    async processIncomingMessages(
        channelId: number,
        messages: IncomingMessage[]
    ): Promise<{ processed: number; persisted: number }> {
        if (messages.length === 0) return { processed: 0, persisted: 0 };

        const claimed = this.claimIncoming(channelId, messages);
        if (claimed.length === 0) return { processed: messages.length, persisted: 0 };

        let emitted = false;
        try {
        await this.ensureRulesFresh();

        const msgIds = claimed.map(m => BigInt(m.telegramId));
        const [existingMessages, channel] = await Promise.all([
            prisma.message.findMany({
                where: { channelId, telegramId: { in: msgIds } },
                select: { telegramId: true }
            }),
            this.getChannel(channelId)
        ]);
        const existingIdsSet = new Set(existingMessages.map(m => m.telegramId.toString()));

        const fresh = claimed.filter(m => !existingIdsSet.has(m.telegramId.toString()));
        if (fresh.length === 0) return { processed: messages.length, persisted: 0 };
        if (!channel) {
            this.releaseClaim(channelId, claimed);
            return { processed: 0, persisted: 0 };
        }

        const channelName = channel.name || channel.link || 'Alert';
        const escapedName = esc(channelName);

        type MessageRow = {
            telegramId: bigint;
            message: string;
            mediaUrl?: string;
            mediaType?: string;
            date: Date;
            channelId: number;
            sent: boolean;
            deliveryLagMs?: number;
            ingestSource?: string;
        };
        const allMessagesToPersist: MessageRow[] = [];
        type Prepared = {
            outMessage: string;
            mediaUrl?: string;
            mediaType?: 'photo' | 'video';
            telegramId: number;
            postedAt: number;
            source: string;
        };
        const prepared: Prepared[] = [];

        for (const msg of fresh) {
            const source = msg.source || 't.me';
            const cleanedText = cleanMessage(msg.text);
            const normalizedText = normalize(cleanedText);
            const passedFilter =
                !this.excludeRules.some(p => normalizedText.includes(p)) &&
                this.includeRules.some(p => normalizedText.includes(p));

            if (passedFilter) {
                logger.info('New message', channelId, {
                    telegramId: msg.telegramId,
                    preview: previewMessageText(cleanedText),
                    matchedFilter: true,
                    source,
                    hasMedia: !!(msg.mediaUrl || msg.mediaType)
                });
            } else {
                logger.debug('New message', channelId, {
                    telegramId: msg.telegramId,
                    preview: previewMessageText(cleanedText),
                    matchedFilter: false,
                    source,
                    hasMedia: !!(msg.mediaUrl || msg.mediaType)
                });
            }

            allMessagesToPersist.push({
                telegramId: BigInt(msg.telegramId),
                message: cleanedText,
                mediaUrl: msg.mediaUrl,
                mediaType: msg.mediaType,
                date: msg.date,
                channelId,
                sent: passedFilter,
                ingestSource: source
            });

            if (!passedFilter) continue;

            const postTime = msg.date.toLocaleTimeString('uk-UA', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                timeZone: 'Europe/Kyiv'
            });
            const escapedText = esc(cleanedText);
            const quotedText = escapedText.split('\n').map(line => `>${line}`).join('\n');
            const outMessage = `🔔 *${escapedName}*\n${quotedText}\n\n🕒 \`${esc(postTime)}\``;
            prepared.push({
                outMessage,
                mediaUrl: msg.mediaUrl,
                mediaType: msg.mediaType,
                telegramId: msg.telegramId,
                postedAt: msg.date.getTime(),
                source
            });
        }

        if (prepared.length > 0) {
            const subscriberIds = await this.getSubscriberIds(channelId);
            if (subscriberIds.length === 0) {
                logger.warn('Matched filter but no subscribers to notify', channelId, {
                    matched: prepared.length,
                    telegramIds: prepared.map(p => p.telegramId)
                });
            } else {
                const queuedAt = Date.now();
                const lagById = new Map(prepared.map(p => [p.telegramId.toString(), Math.max(0, queuedAt - p.postedAt)]));
                for (const row of allMessagesToPersist) {
                    const lag = lagById.get(row.telegramId.toString());
                    if (lag != null) row.deliveryLagMs = lag;
                }
                emitted = true;
                emitAlerts({
                    channelId,
                    channelName,
                    items: prepared.map(p => ({
                        outMessage: p.outMessage,
                        mediaUrl: p.mediaUrl,
                        mediaType: p.mediaType,
                        telegramId: p.telegramId,
                        postedAt: p.postedAt,
                        source: p.source
                    })),
                    subscriberIds
                });
                prepared.forEach(p =>
                    logger.info(`🚨 Alert queued for ${p.telegramId}`, channelId, {
                        subscribers: subscriberIds.length,
                        source: p.source
                    })
                );
            }
        }

        if (allMessagesToPersist.length > 0) {
            const rows = allMessagesToPersist;
            void Promise.all(
                rows.map(m =>
                    prisma.message.upsert({
                        where: {
                            telegramId_channelId: {
                                telegramId: m.telegramId,
                                channelId: m.channelId
                            }
                        },
                        create: {
                            telegramId: m.telegramId,
                            message: m.message,
                            mediaUrl: m.mediaUrl,
                            mediaType: m.mediaType,
                            date: m.date,
                            sent: m.sent,
                            deliveryLagMs: m.deliveryLagMs,
                            ingestSource: m.ingestSource,
                            channelId: m.channelId
                        },
                        update: {}
                    })
                )
            )
                .then(results => {
                    logger.info(`Persisted ${results.length} message(s)`, channelId, {
                        attempted: rows.length
                    });
                })
                .catch(e => logger.error('Failed to persist messages', channelId, { error: e }));
            return { processed: messages.length, persisted: rows.length };
        }

        return { processed: messages.length, persisted: 0 };
        } catch (e) {
            if (!emitted) this.releaseClaim(channelId, claimed);
            throw e;
        }
    }
}
