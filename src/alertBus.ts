import { EventEmitter } from 'events';

export type AlertItem = {
    outMessage: string;
    mediaUrl?: string;
    mediaType?: 'photo' | 'video';
    telegramId: number;
};

export type AlertsPayload = {
    channelId: number;
    channelName: string;
    items: AlertItem[];
    subscriberIds: bigint[];
};

const alertBus = new EventEmitter();
alertBus.setMaxListeners(20);

export const ALERTS_EVENT = 'alerts';

export function emitAlerts(payload: AlertsPayload): void {
    alertBus.emit(ALERTS_EVENT, payload);
}

export function onAlerts(handler: (payload: AlertsPayload) => void): void {
    alertBus.on(ALERTS_EVENT, handler);
}
