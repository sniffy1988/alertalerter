import { bot } from './bot';
import { onAlerts, type AlertsPayload, type AlertItem } from './alertBus';
import { logger } from './logger';

const SEND_CONCURRENCY = 25;

class Semaphore {
    private active = 0;
    private queue: (() => void)[] = [];

    constructor(private readonly limit: number) {}

    async acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active++;
            return;
        }
        await new Promise<void>(resolve => this.queue.push(resolve));
        this.active++;
    }

    release(): void {
        this.active--;
        const next = this.queue.shift();
        if (next) next();
    }
}

const sendSemaphore = new Semaphore(SEND_CONCURRENCY);

function getRetryAfterMs(err: unknown): number | null {
    const e = err as { error_code?: number; parameters?: { retry_after?: number } };
    if (e?.error_code === 429 && e.parameters?.retry_after != null) {
        return e.parameters.retry_after * 1000;
    }
    return null;
}

async function sendWithRetry(
    sendFn: () => Promise<unknown>,
    chatId: string,
    channelId: number
): Promise<void> {
    await sendSemaphore.acquire();
    try {
        await sendFn();
    } catch (err) {
        const retryAfter = getRetryAfterMs(err);
        if (retryAfter != null) {
            await new Promise(r => setTimeout(r, retryAfter));
            try {
                await sendFn();
                return;
            } catch (retryErr) {
                logger.error('Alert send failed after retry', channelId, { chatId, error: retryErr });
                return;
            }
        }
        logger.error('Alert send failed', channelId, { chatId, error: err });
    } finally {
        sendSemaphore.release();
    }
}

function sendOne(chatId: string, item: AlertItem, channelId: number): Promise<void> {
    const options = { parse_mode: 'MarkdownV2' as const };
    const opts = { ...options, caption: item.outMessage };

    if (item.mediaUrl) {
        if (item.mediaType === 'photo') {
            return sendWithRetry(() => bot.api.sendPhoto(chatId, item.mediaUrl!, opts), chatId, channelId);
        }
        if (item.mediaType === 'video') {
            return sendWithRetry(() => bot.api.sendVideo(chatId, item.mediaUrl!, opts), chatId, channelId);
        }
    }
    return sendWithRetry(() => bot.api.sendMessage(chatId, item.outMessage, options), chatId, channelId);
}

function sendAlerts(payload: AlertsPayload): void {
    const allSends = payload.items.flatMap(item =>
        payload.subscriberIds.map(telegramId =>
            sendOne(String(telegramId), item, payload.channelId)
        )
    );
    Promise.all(allSends).catch(e => logger.error('Alert send batch failed', payload.channelId, { error: e }));
}

export function registerAlertSender(): void {
    onAlerts(payload => sendAlerts(payload));
}
