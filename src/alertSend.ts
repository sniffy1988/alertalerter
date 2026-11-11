import { bot } from './bot';
import prisma from './db';
import { logger } from './logger';

function telegramApiErrorCode(err: unknown): number | undefined {
    if (!err || typeof err !== 'object') return undefined;
    const code = (err as { error_code?: number }).error_code;
    return typeof code === 'number' ? code : undefined;
}

function isSubscriberUnreachable(err: unknown): boolean {
    const code = telegramApiErrorCode(err);
    return code === 403 || code === 400;
}

export type OutgoingAlert = {
    outMessage: string;
    mediaUrl?: string;
    mediaType?: 'photo' | 'video';
    postedAt: number;
    source: string;
};

function formatDeliveryLag(ms: number): string {
    const clamped = Math.max(0, ms);
    if (clamped < 10_000) return `+${(clamped / 1000).toFixed(1)} с`;
    const totalSec = Math.round(clamped / 1000);
    if (totalSec < 60) return `+${totalSec} с`;
    const min = Math.floor(totalSec / 60);
    const rem = totalSec % 60;
    return rem === 0 ? `+${min} мин` : `+${min} мин ${rem} с`;
}

function outgoingText(item: OutgoingAlert): string {
    if (!Number.isFinite(item.postedAt)) return item.outMessage;
    const lagMs = Math.max(0, Date.now() - item.postedAt);
    const label = item.source ? `${formatDeliveryLag(lagMs)} · ${item.source}` : formatDeliveryLag(lagMs);
    return `${item.outMessage}\n⏱ \`${label}\``;
}

function sendOne(chatId: string, item: OutgoingAlert, channelId: number): void {
    const options = { parse_mode: 'MarkdownV2' as const };
    const text = outgoingText(item);

    const onFail = (err: unknown) => {
        if (isSubscriberUnreachable(err)) {
            const telegramId = BigInt(chatId);
            void prisma.user
                .updateMany({
                    where: { telegramId, silentMode: false },
                    data: { silentMode: true }
                })
                .catch(updateErr => {
                    logger.warn('Could not mark subscriber unreachable', channelId, {
                        chatId,
                        error: updateErr
                    });
                });
            logger.info('Subscriber unreachable; silent mode enabled', channelId, {
                chatId,
                errorCode: telegramApiErrorCode(err)
            });
            return;
        }
        logger.error('Alert send failed', channelId, { chatId, error: err });
    };

    if (item.mediaUrl) {
        if (item.mediaType === 'photo') {
            void bot.api.sendPhoto(chatId, item.mediaUrl, { ...options, caption: text }).catch(onFail);
            return;
        }
        if (item.mediaType === 'video') {
            void bot.api.sendVideo(chatId, item.mediaUrl, { ...options, caption: text }).catch(onFail);
            return;
        }
    }
    void bot.api.sendMessage(chatId, text, options).catch(onFail);
}

export function sendAlertToSubscribers(
    channelId: number,
    subscriberIds: bigint[],
    item: OutgoingAlert
): void {
    for (const telegramId of subscriberIds) {
        sendOne(String(telegramId), item, channelId);
    }
}
