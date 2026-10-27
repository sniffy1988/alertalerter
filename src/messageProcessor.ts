import prisma from './db';
import { logger } from './logger';
import { normalizePhrase, passesFilter, type FilterRules } from './rules';
import { sendAlertToSubscribers } from './alertSend';

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

function esc(text: string): string {
    return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
}

const LOOKUP_CACHE_TTL_MS = 30_000;

type CachedSubscribers = { ids: bigint[]; expiresAt: number };

const subscriberCache = new Map<number, CachedSubscribers>();

export async function fetchSubscriberIds(channelId: number): Promise<bigint[]> {
    const cached = subscriberCache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) return cached.ids;

    const users = await prisma.user.findMany({
        where: { subscribedTo: { some: { id: channelId } }, silentMode: false },
        select: { telegramId: true }
    });
    const ids = users.map(u => u.telegramId);
    subscriberCache.set(channelId, {
        ids,
        expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS
    });
    return ids;
}

export function buildAlertBody(channelName: string, cleanedText: string, date: Date): string {
    const escapedName = esc(channelName);
    const postTime = date.toLocaleTimeString('uk-UA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Europe/Kyiv'
    });
    const escapedText = esc(cleanedText);
    const quotedText = escapedText.split('\n').map(line => `>${line}`).join('\n');
    return `🔔 *${escapedName}*\n${quotedText}\n\n🕒 \`${esc(postTime)}\``;
}

export async function persistMessage(row: {
    telegramId: number;
    message: string;
    mediaUrl?: string;
    mediaType?: string;
    date: Date;
    channelId: number;
    sent: boolean;
    deliveryLagMs?: number;
    ingestSource?: string;
}): Promise<void> {
    await prisma.message.upsert({
        where: {
            telegramId_channelId: {
                telegramId: BigInt(row.telegramId),
                channelId: row.channelId
            }
        },
        create: {
            telegramId: BigInt(row.telegramId),
            message: row.message,
            mediaUrl: row.mediaUrl,
            mediaType: row.mediaType,
            date: row.date,
            sent: row.sent,
            deliveryLagMs: row.deliveryLagMs,
            ingestSource: row.ingestSource,
            channelId: row.channelId
        },
        update: {}
    });
}

/** Persists the post. Sends alert only when `shouldNotify` and phrase filter matches. */
export async function handleIncomingPost(
    channelId: number,
    channelName: string,
    msg: IncomingMessage,
    rules: FilterRules,
    shouldNotify: boolean
): Promise<boolean> {
    const source = msg.source || 't.me';
    const cleanedText = cleanMessage(msg.text);
    const normalizedText = normalizePhrase(cleanedText);
    const matched = passesFilter(normalizedText, rules);

    if (matched) {
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

    const queuedAt = Date.now();
    const deliveryLagMs = matched ? Math.max(0, queuedAt - msg.date.getTime()) : undefined;

    try {
        await persistMessage({
            telegramId: msg.telegramId,
            message: cleanedText,
            mediaUrl: msg.mediaUrl,
            mediaType: msg.mediaType,
            date: msg.date,
            channelId,
            sent: matched,
            deliveryLagMs,
            ingestSource: source
        });
    } catch (error) {
        logger.error('Failed to persist message', channelId, { telegramId: msg.telegramId, error });
        return false;
    }

    if (!matched || !shouldNotify) return false;

    const subscriberIds = await fetchSubscriberIds(channelId);
    if (subscriberIds.length === 0) {
        logger.warn('Matched filter but no subscribers to notify', channelId, {
            telegramId: msg.telegramId
        });
        return false;
    }

    const outMessage = buildAlertBody(channelName, cleanedText, msg.date);
    sendAlertToSubscribers(channelId, subscriberIds, {
        outMessage,
        mediaUrl: msg.mediaUrl,
        mediaType: msg.mediaType,
        postedAt: msg.date.getTime(),
        source
    });
    logger.info(`🚨 Alert sent for ${msg.telegramId}`, channelId, {
        subscribers: subscriberIds.length,
        source
    });
    return true;
}
