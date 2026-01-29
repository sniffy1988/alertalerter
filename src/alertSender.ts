import { bot } from './bot';
import { onAlerts, type AlertsPayload } from './alertBus';
import { logger } from './logger';

function sendAlerts(payload: AlertsPayload): void {
    const options = { parse_mode: 'MarkdownV2' as const };
    const allSends = payload.items.flatMap(p =>
        payload.subscriberIds.map(telegramId => {
            const chatId = Number(telegramId);
            const opts = { ...options, caption: p.outMessage };
            if (p.mediaUrl) {
                if (p.mediaType === 'photo') return bot.api.sendPhoto(chatId, p.mediaUrl, opts).catch(() => {});
                if (p.mediaType === 'video') return bot.api.sendVideo(chatId, p.mediaUrl, opts).catch(() => {});
            }
            return bot.api.sendMessage(chatId, p.outMessage, options).catch(() => {});
        })
    );
    Promise.all(allSends).catch(e => logger.error('Alert send batch failed', payload.channelId, { error: e }));
}

export function registerAlertSender(): void {
    onAlerts(payload => sendAlerts(payload));
}
