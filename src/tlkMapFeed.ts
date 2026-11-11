import axios from 'axios';
import prisma from './db';
import { getChannelFeed } from './channelFeed';
import { logger } from './logger';
import { normalizeChannelLink } from './seedLib';
import type { IncomingMessage } from './messageProcessor';

const TRACKS_URL = 'https://tlkmapalarm.xyz/api/tracks';
const TLK_LINK = 'tlknewsua';
const REQUEST_TIMEOUT_MS = 8000;
const MAP_SOURCE = 'tlk-map';
const FAILURE_BACKOFF_START_MS = 500;
const FAILURE_BACKOFF_CAP_MS = 30_000;
const FEED_WAIT_MS = 2_000;

type GeoPoint = { lat: number; lon: number };

type MapObservation = {
    observationId: string;
    telegramPostId: string;
    observedAt: string;
    text?: string;
    placeName?: string;
    uavType?: string;
    location?: { point?: GeoPoint };
};

type MapTrack = {
    marker?: { observation?: MapObservation };
};

type TracksResponse = {
    tracks?: MapTrack[];
};

function parseTelegramPostId(telegramPostId: string): number | null {
    const part = telegramPostId.split(':').pop();
    if (!part) return null;
    const id = parseInt(part, 10);
    return Number.isFinite(id) && id > 0 ? id : null;
}

function formatMapAlertText(obs: MapObservation): string | null {
    const text = obs.text?.trim();
    if (!text) return null;
    const lines = [text];
    const place = obs.placeName?.trim();
    const uavType = obs.uavType?.trim();
    if (place || uavType) {
        const typeLabel = uavType ?? '';
        lines.push(place && typeLabel ? `${place} · ${typeLabel}` : place || typeLabel);
    }
    const point = obs.location?.point;
    if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
        lines.push(`${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`);
    }
    return lines.join('\n');
}

function observationsFromPayload(data: TracksResponse): MapObservation[] {
    const out: MapObservation[] = [];
    for (const track of data.tracks ?? []) {
        const obs = track.marker?.observation;
        if (obs?.telegramPostId && obs.text?.trim()) out.push(obs);
    }
    return out;
}

function toIncomingMessages(observations: MapObservation[]): IncomingMessage[] {
    const byPostId = new Map<number, IncomingMessage>();
    for (const obs of observations) {
        const telegramId = parseTelegramPostId(obs.telegramPostId);
        if (telegramId == null) continue;
        const text = formatMapAlertText(obs);
        if (!text) continue;
        const observedAt = obs.observedAt ? new Date(obs.observedAt) : new Date();
        const date = Number.isFinite(observedAt.getTime()) ? observedAt : new Date();
        byPostId.set(telegramId, {
            telegramId,
            text,
            date,
            source: MAP_SOURCE
        });
    }
    return [...byPostId.values()].sort((a, b) => a.telegramId - b.telegramId);
}

async function fetchTracks(): Promise<IncomingMessage[]> {
    const response = await axios.get<TracksResponse>(TRACKS_URL, {
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: status => status >= 200 && status < 300
    });
    return toIncomingMessages(observationsFromPayload(response.data));
}

export async function startTlkMapFeed(): Promise<void> {
    const normalized = normalizeChannelLink(TLK_LINK);
    const channel = await prisma.channel.findFirst({
        where: { link: normalized },
        select: { id: true, scrapTimeout: true }
    });
    if (!channel) {
        logger.warn('TLK map feed: channel not found', undefined, { link: TLK_LINK });
        return;
    }

    let failureStreak = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const pollIntervalMs = (): number => {
        const configured = Number(channel.scrapTimeout);
        if (!Number.isFinite(configured) || configured < 50) return 1500;
        return configured;
    };

    const scheduleNext = (delayMs: number) => {
        if (stopped) return;
        pollTimer = setTimeout(() => void pollOnce(), delayMs);
    };

    const pollOnce = async () => {
        if (stopped) return;
        const feed = getChannelFeed(channel.id);
        if (!feed) {
            scheduleNext(FEED_WAIT_MS);
            return;
        }
        try {
            const messages = await fetchTracks();
            if (messages.length > 0) feed.push(messages);
            failureStreak = 0;
            scheduleNext(pollIntervalMs());
        } catch (error) {
            failureStreak += 1;
            const backoffMs = Math.min(
                FAILURE_BACKOFF_CAP_MS,
                FAILURE_BACKOFF_START_MS * 2 ** (failureStreak - 1)
            );
            logger.warn('TLK map tracks poll failed', channel.id, {
                error: error instanceof Error ? error.message : String(error),
                backoffMs
            });
            scheduleNext(backoffMs);
        }
    };

    logger.info('TLK map feed started', channel.id, { intervalMs: pollIntervalMs() });
    scheduleNext(0);

    const stop = () => {
        stopped = true;
        if (pollTimer != null) clearTimeout(pollTimer);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
