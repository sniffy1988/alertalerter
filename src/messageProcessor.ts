import prisma from './db';
import { logger } from './logger';
import { emitAlerts } from './alertBus';

export type IngestSource = 'mtproto' | 'scrape';

export type IncomingMessage = {
    telegramId: number;
    text: string;
    mediaUrl?: string;
    mediaType?: 'photo' | 'video';
    date: Date;
    sender?: string;
};

export function cleanMessage(text: string): string {
    return text
        .replace(/📷TlkInst/gi, ' ')
        .replace(/🎞Канал со стримами/gi, ' ')
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
        messages: IncomingMessage[],
        source: IngestSource
    ): Promise<{ processed: number; persisted: number }> {
        if (messages.length === 0) return { processed: 0, persisted: 0 };

        await this.ensureRulesFresh();

        const msgIds = messages.map(m => BigInt(m.telegramId));
        const existingMessages = await prisma.message.findMany({
            where: { channelId, telegramId: { in: msgIds } },
            select: { telegramId: true }
        });
        const existingIdsSet = new Set(existingMessages.map(m => m.telegramId.toString()));

        const fresh = messages.filter(m =>
            !existingIdsSet.has(m.telegramId.toString()) && !this.isRecentlyEmitted(channelId, m.telegramId)
        );
        if (fresh.length === 0) return { processed: messages.length, persisted: 0 };

        const channel = await this.getChannel(channelId);
        if (!channel) return { processed: 0, persisted: 0 };

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
        };
        const allMessagesToPersist: MessageRow[] = [];
        type Prepared = {
            outMessage: string;
            mediaUrl?: string;
            mediaType?: 'photo' | 'video';
            telegramId: number;
        };
        const prepared: Prepared[] = [];

        for (const msg of fresh) {
            const cleanedText = cleanMessage(msg.text);
            const normalizedText = normalize(cleanedText);
            const passedFilter =
                !this.excludeRules.some(p => normalizedText.includes(p)) &&
                this.includeRules.some(p => normalizedText.includes(p));

            if (passedFilter) {
                logger.info(`New message (${source})`, channelId, {
                    telegramId: msg.telegramId,
                    preview: previewMessageText(cleanedText),
                    matchedFilter: true,
                    hasMedia: !!(msg.mediaUrl || msg.mediaType)
                });
            } else {
                logger.debug(`New message (${source})`, channelId, {
                    telegramId: msg.telegramId,
                    preview: previewMessageText(cleanedText),
                    matchedFilter: false,
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
                sent: passedFilter
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
                telegramId: msg.telegramId
            });
        }

        if (prepared.length > 0) {
            const subscriberIds = await this.getSubscriberIds(channelId);
            if (subscriberIds.length > 0) {
                for (const p of prepared) {
                    this.markRecentlyEmitted(channelId, p.telegramId);
                }
                emitAlerts({
                    channelId,
                    channelName,
                    items: prepared.map(p => ({
                        outMessage: p.outMessage,
                        mediaUrl: p.mediaUrl,
                        mediaType: p.mediaType,
                        telegramId: p.telegramId
                    })),
                    subscriberIds
                });
                prepared.forEach(p =>
                    logger.info(`🚨 Alert queued (${source}) for ${p.telegramId}`, channelId)
                );
            }
        }

        if (allMessagesToPersist.length > 0) {
            try {
                // SQLite does not support createMany skipDuplicates — upserts stay.
                const results = await Promise.all(
                    allMessagesToPersist.map(m =>
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
                                channelId: m.channelId
                            },
                            update: {}
                        })
                    )
                );
                logger.info(`Persisted ${results.length} message(s) (${source})`, channelId, {
                    attempted: allMessagesToPersist.length
                });
                return { processed: messages.length, persisted: results.length };
            } catch (e) {
                logger.error(`Failed to persist messages (${source})`, channelId, { error: e });
            }
        }

        return { processed: messages.length, persisted: 0 };
    }
}
