import prisma from './db';
import { logger } from './logger';

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

type CachedRule = { phrase: string; exclude: boolean };

export class MessageProcessor {
    private rulesCache: CachedRule[] = [];
    private lastRulesRefreshAt = 0;
    private recentlyEmitted = new Map<number, Map<string, number>>();
    private static readonly RULES_CACHE_TTL_MS = 60_000;
    private static readonly RECENTLY_EMITTED_TTL_MS = 60_000;

    private async refreshRulesCache(): Promise<void> {
        const rules = await prisma.filterPhrase.findMany();
        this.rulesCache = rules.map(r => ({ phrase: r.phrase, exclude: r.exclude }));
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

    async processIncomingMessages(
        channelId: number,
        messages: IncomingMessage[],
        source: IngestSource
    ): Promise<void> {
        if (messages.length === 0) return;

        const channel = await prisma.channel.findUnique({ where: { id: channelId } });
        if (!channel) return;

        const channelName = channel.name || channel.link || 'Alert';
        await this.ensureRulesFresh();

        const subscribers = await prisma.user.findMany({
            where: { subscribedTo: { some: { id: channelId } }, silentMode: false }
        });

        const rules = this.rulesCache;
        const normalize = (s: string) => s.toLowerCase().replace(/[’ʼ]/g, "'").trim();
        const esc = (text: string) => text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
        const escapedName = esc(channelName);

        const excludeRules = rules.filter(r => r.exclude).map(r => normalize(r.phrase));
        const includeRules = rules.filter(r => !r.exclude).map(r => normalize(r.phrase));

        const msgIds = messages.map(m => BigInt(m.telegramId));
        const existingMessages = await prisma.message.findMany({
            where: { channelId, telegramId: { in: msgIds } },
            select: { telegramId: true }
        });
        const existingIdsSet = new Set(existingMessages.map(m => m.telegramId.toString()));

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

        for (const msg of messages) {
            const idStr = msg.telegramId.toString();
            if (existingIdsSet.has(idStr) || this.isRecentlyEmitted(channelId, msg.telegramId)) {
                logger.debug(`Skipped duplicate (${source})`, channelId, { telegramId: msg.telegramId });
                continue;
            }

            const cleanedText = cleanMessage(msg.text);
            const normalizedText = normalize(cleanedText);
            const passedFilter =
                !excludeRules.some(p => normalizedText.includes(p)) &&
                includeRules.some(p => normalizedText.includes(p));

            logger.info(`New message (${source})`, channelId, {
                telegramId: msg.telegramId,
                preview: previewMessageText(cleanedText),
                matchedFilter: passedFilter,
                hasMedia: !!(msg.mediaUrl || msg.mediaType)
            });

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

        if (prepared.length > 0 && subscribers.length > 0) {
            const { emitAlerts } = await import('./alertBus');
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
                subscriberIds: subscribers.map(s => s.telegramId)
            });
            prepared.forEach(p =>
                logger.info(`🚨 Alert queued (${source}) for ${p.telegramId}`, channelId)
            );
        }

        if (allMessagesToPersist.length > 0) {
            void prisma.message.createMany({
                data: allMessagesToPersist.map(m => ({
                    telegramId: m.telegramId,
                    message: m.message,
                    mediaUrl: m.mediaUrl,
                    mediaType: m.mediaType,
                    date: m.date,
                    sent: m.sent,
                    channelId: m.channelId
                }))
            }).catch(e => logger.error(`Failed to persist messages (${source})`, channelId, { error: e }));
        }
    }
}
