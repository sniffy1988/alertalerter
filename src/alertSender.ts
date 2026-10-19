import { bot } from './bot';
import { onAlerts, type AlertsPayload, type AlertItem } from './alertBus';
import { logger } from './logger';

function parseSendConcurrency(): number {
    const n = Number(process.env.ALERT_SEND_CONCURRENCY);
    if (Number.isFinite(n) && n >= 1) return Math.min(25, Math.floor(n));
    return 8;
}

const SEND_CONCURRENCY = parseSendConcurrency();

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
const SENDS_PER_SECOND = 20;

class SendPacer {
    private nextAt = 0;
    private blockedUntil = 0;

    blockFor(ms: number): void {
        const until = Date.now() + ms;
        if (until > this.blockedUntil) this.blockedUntil = until;
    }

    async waitTurn(): Promise<void> {
        const gap = 1000 / SENDS_PER_SECOND;
        const now = Date.now();
        const at = Math.max(now, this.nextAt, this.blockedUntil);
        this.nextAt = at + gap;
        const wait = at - now;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
}

const sendPacer = new SendPacer();

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
    await sendPacer.waitTurn();
    await sendSemaphore.acquire();
    let held = true;
    try {
        await sendFn();
    } catch (err) {
        const retryAfter = getRetryAfterMs(err);
        if (retryAfter == null) {
            logger.error('Alert send failed', channelId, { chatId, error: err });
            return;
        }
        sendPacer.blockFor(retryAfter);
        sendSemaphore.release();
        held = false;
        await new Promise(r => setTimeout(r, retryAfter));
        await sendSemaphore.acquire();
        held = true;
        try {
            await sendFn();
        } catch (retryErr) {
            logger.error('Alert send failed after retry', channelId, { chatId, error: retryErr });
        }
    } finally {
        if (held) sendSemaphore.release();
    }
}

function outgoingText(item: AlertItem): string {
    if (!Number.isFinite(item.postedAt)) return item.outMessage;
    const lagMs = Math.max(0, Date.now() - item.postedAt);
    const label = item.source ? `${formatDeliveryLag(lagMs)} · ${item.source}` : formatDeliveryLag(lagMs);
    return `${item.outMessage}\n⏱ \`${label}\``;
}

function formatDeliveryLag(ms: number): string {
    const clamped = Math.max(0, ms);
    if (clamped < 10_000) return `+${(clamped / 1000).toFixed(1)} с`;
    const totalSec = Math.round(clamped / 1000);
    if (totalSec < 60) return `+${totalSec} с`;
    const min = Math.floor(totalSec / 60);
    const rem = totalSec % 60;
    return rem === 0 ? `+${min} мин` : `+${min} мин ${rem} с`;
}

function sendOne(chatId: string, item: AlertItem, channelId: number): Promise<void> {
    const options = { parse_mode: 'MarkdownV2' as const };
    const deliver = (send: (text: string) => Promise<unknown>) =>
        sendWithRetry(() => send(outgoingText(item)), chatId, channelId);

    if (item.mediaUrl) {
        if (item.mediaType === 'photo') {
            return deliver(text => bot.api.sendPhoto(chatId, item.mediaUrl!, { ...options, caption: text }));
        }
        if (item.mediaType === 'video') {
            return deliver(text => bot.api.sendVideo(chatId, item.mediaUrl!, { ...options, caption: text }));
        }
    }
    return deliver(text => bot.api.sendMessage(chatId, text, options));
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
