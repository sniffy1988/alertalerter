import fs from 'fs';
import { TelegramClient, utils } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Raw } from 'telegram/events';
import { Api } from 'telegram/tl';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor, previewMessageText } from './messageProcessor';
import { peerIdAliases, resolvePeerIdFromEntity } from './telegramPeerId';

const MAX_HISTORICAL_POST_AGE_MS = 120_000;
const KEEP_ALIVE_MS = 30_000;
const CHANNEL_REFRESH_MS = 30_000;
const RESYNC_COOLDOWN_MS = 15_000;
const RESYNC_HISTORY_LIMIT = 30;
const HOT_DIFFERENCE_LIMIT = 10;
const SUBSCRIBE_DIFFERENCE_LIMIT = 100;
const POLL_TICK_MS = 50;
const OUTDATED_BACKOFF_START_MS = 1_000;
const OUTDATED_BACKOFF_CAP_MS = 5_000;
const OUTDATED_FORCE_MIN_STREAK = 3;
const NO_DIFF_RESYNC_MS = 30_000;
const LIVE_PUSH_POLL_GUARD_MS = 1_000;

type IngestMode = 'live' | 'historical';

function parsePollConcurrency(): number {
    const n = Number(process.env.MTPROTO_POLL_CONCURRENCY);
    if (Number.isFinite(n) && n >= 1) return Math.min(32, Math.floor(n));
    return 8;
}

function parsePollIntervalMs(): number {
    const n = Number(process.env.MTPROTO_POLL_INTERVAL_MS);
    if (Number.isFinite(n) && n >= 100) return Math.min(10_000, Math.floor(n));
    return 400;
}

function isPtsOutdated(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /PERSISTENT_TIMESTAMP_OUTDATED/i.test(message);
}

function parseFloodWaitSeconds(error: unknown): number | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/FLOOD_WAIT[_\s](\d+)/i);
    if (match) return Number(match[1]);
    return null;
}

function diffTimeoutSeconds(diff: Api.updates.TypeChannelDifference): number | undefined {
    if (diff instanceof Api.updates.ChannelDifferenceEmpty || diff instanceof Api.updates.ChannelDifference) {
        const timeout = diff.timeout;
        if (timeout != null && Number(timeout) > 0) return Number(timeout);
    }
    return undefined;
}

function pollDelayAfterDifference(diff: Api.updates.TypeChannelDifference, pollIntervalMs: number): number {
    const timeoutSec = diffTimeoutSeconds(diff);
    if (timeoutSec != null) return Math.max(pollIntervalMs, timeoutSec * 1000);
    return pollIntervalMs;
}

function collectChannelMessageUpdates(update: Api.TypeUpdate): Api.UpdateNewChannelMessage[] {
    const out: Api.UpdateNewChannelMessage[] = [];
    if (update instanceof Api.UpdateNewChannelMessage) {
        out.push(update);
        return out;
    }
    if ('updates' in update && Array.isArray((update as { updates?: Api.TypeUpdate[] }).updates)) {
        for (const inner of (update as { updates: Api.TypeUpdate[] }).updates) {
            if (inner instanceof Api.UpdateNewChannelMessage) out.push(inner);
        }
    }
    return out;
}

type ChannelMapping = { channelId: number; username: string; peerId: string };

function readSession(): string | null {
    const inline = process.env.TELEGRAM_USER_SESSION?.trim();
    if (inline) return inline;

    const candidates = [process.env.TELEGRAM_SESSION_PATH?.trim(), 'db_data/telegram.session'].filter(
        (path): path is string => !!path
    );
    for (const path of candidates) {
        if (!fs.existsSync(path)) continue;
        const text = fs.readFileSync(path, 'utf8').trim();
        if (text) return text;
    }
    return null;
}

function channelUsername(link: string): string | null {
    const trimmed = link.trim().replace(/^@/, '');
    const fromUrl = trimmed.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]+)/i);
    if (fromUrl) return fromUrl[1];
    return /^[A-Za-z0-9_]+$/.test(trimmed) ? trimmed : null;
}

async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>
): Promise<void> {
    if (items.length === 0) return;
    let index = 0;
    const workerCount = Math.min(limit, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (index < items.length) {
            const i = index++;
            await fn(items[i]);
        }
    });
    await Promise.all(workers);
}

export async function startMtprotoIngest(processor: MessageProcessor): Promise<void> {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH?.trim();
    const session = readSession();
    if (!apiId || !apiHash || !session) {
        logger.info('MTProto ingest off (no api id, hash, or user session)');
        return;
    }

    const pollConcurrency = parsePollConcurrency();
    const pollIntervalMs = parsePollIntervalMs();

    const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
        connectionRetries: 5,
        autoReconnect: true
    });

    try {
        await client.connect();
        if (!(await client.checkAuthorization())) {
            logger.error('MTProto session is not authorized');
            return;
        }
        await client.getDialogs({ limit: 100 });
    } catch (error) {
        logger.error('MTProto ingest failed to connect', undefined, { error });
        return;
    }

    const peerToChannel = new Map<string, ChannelMapping>();
    const channelMappings = new Map<number, ChannelMapping>();
    const channelPts = new Map<number, number>();
    const channelEntities = new Map<number, Api.Channel>();
    const channelNextPollAt = new Map<number, number>();
    const channelPollDelayMs = new Map<number, number>();
    const pollInFlight = new Set<number>();
    const resyncNotBefore = new Map<number, number>();
    const outdatedStreak = new Map<number, number>();
    const lastSuccessfulDiffAt = new Map<number, number>();
    const groupedSeen = new Set<string>();
    let globalPollPausedUntil = 0;
    let running = true;

    const remember = (mapping: ChannelMapping) => {
        channelMappings.set(mapping.channelId, mapping);
        for (const alias of peerIdAliases(mapping.peerId)) {
            peerToChannel.set(alias, mapping);
        }
    };

    const setChannelPts = (channelId: number, pts: number) => {
        const prev = channelPts.get(channelId) ?? 0;
        if (pts > prev) channelPts.set(channelId, pts);
    };

    const bumpPollAfterLivePush = (channelId: number) => {
        const minNext = Date.now() + Math.max(pollIntervalMs, LIVE_PUSH_POLL_GUARD_MS);
        const cur = channelNextPollAt.get(channelId) ?? 0;
        if (minNext > cur) channelNextPollAt.set(channelId, minNext);
    };

    const scheduleProcessor = (channelId: number, messages: Parameters<MessageProcessor['processIncomingMessages']>[1]) => {
        void processor.processIncomingMessages(channelId, messages).catch(error => {
            logger.error('MTProto processIncomingMessages failed', channelId, { error });
        });
    };

    const ingest = (msg: Api.Message, mapping: ChannelMapping, mode: IngestMode) => {
        if (!msg.peerId) {
            logger.debug('MTProto skip message', mapping.channelId, {
                reason: 'no_peer',
                telegramId: msg.id
            });
            return;
        }
        if (msg.editDate) {
            logger.debug('MTProto skip message', mapping.channelId, {
                reason: 'edit',
                telegramId: msg.id
            });
            return;
        }

        const postedAt = (msg.date ?? 0) * 1000;
        if (!postedAt) {
            logger.debug('MTProto skip message', mapping.channelId, {
                reason: 'no_date',
                telegramId: msg.id
            });
            return;
        }
        if (mode === 'historical' && Date.now() - postedAt > MAX_HISTORICAL_POST_AGE_MS) {
            logger.debug('MTProto skip message', mapping.channelId, {
                reason: 'too_old',
                telegramId: msg.id,
                ageSec: Math.round((Date.now() - postedAt) / 1000)
            });
            return;
        }

        if (msg.groupedId) {
            const key = `${mapping.peerId}:${msg.groupedId.toString()}`;
            if (groupedSeen.has(key)) {
                logger.debug('MTProto skip message', mapping.channelId, {
                    reason: 'grouped_duplicate',
                    telegramId: msg.id
                });
                return;
            }
            groupedSeen.add(key);
            if (groupedSeen.size > 1000) groupedSeen.clear();
        }

        const text = msg.message?.trim() ? msg.message : msg.media ? '(media)' : '';
        if (!text.trim()) {
            logger.debug('MTProto skip message', mapping.channelId, {
                reason: 'empty_text',
                telegramId: msg.id
            });
            return;
        }

        logger.info('MTProto push received', mapping.channelId, {
            username: mapping.username,
            telegramId: msg.id,
            preview: previewMessageText(text),
            mode
        });
        scheduleProcessor(mapping.channelId, [
            {
                telegramId: msg.id,
                text,
                date: new Date(postedAt),
                source: 'mtproto'
            }
        ]);
    };

    const ingestFromMessage = (msg: Api.Message, mode: IngestMode) => {
        if (!msg.peerId) return;
        const peerId = utils.getPeerId(msg.peerId).toString();
        const mapping = peerToChannel.get(peerId);
        if (!mapping) {
            logger.debug('MTProto skip message', undefined, {
                reason: 'unknown_peer',
                telegramId: msg.id,
                peerId
            });
            return;
        }
        ingest(msg, mapping, mode);
    };

    const markDifferenceSuccess = (channelId: number) => {
        outdatedStreak.delete(channelId);
        lastSuccessfulDiffAt.set(channelId, Date.now());
    };

    const applyDifference = (
        channelId: number,
        diff: Api.updates.TypeChannelDifference,
        mode: IngestMode
    ): number => {
        if (diff instanceof Api.updates.ChannelDifferenceEmpty) {
            setChannelPts(channelId, Number(diff.pts));
            markDifferenceSuccess(channelId);
            return pollDelayAfterDifference(diff, pollIntervalMs);
        }
        if (diff instanceof Api.updates.ChannelDifference) {
            setChannelPts(channelId, Number(diff.pts));
            markDifferenceSuccess(channelId);
            const messages = diff.newMessages ?? [];
            if (messages.length > 0) {
                logger.info('MTProto channel difference', channelId, {
                    newMessages: messages.length,
                    pts: Number(diff.pts),
                    final: diff.final ?? true
                });
            }
            for (const message of messages) {
                if (message instanceof Api.Message) ingestFromMessage(message, mode);
            }
            return pollDelayAfterDifference(diff, pollIntervalMs);
        }
        if (diff instanceof Api.updates.ChannelDifferenceTooLong) {
            const dialogPts = diff.dialog && 'pts' in diff.dialog ? Number(diff.dialog.pts) : undefined;
            if (dialogPts != null) setChannelPts(channelId, dialogPts);
            markDifferenceSuccess(channelId);
            logger.info('MTProto channel difference too long', channelId, { messages: diff.messages?.length ?? 0 });
            for (const message of diff.messages ?? []) {
                if (message instanceof Api.Message) ingestFromMessage(message, mode);
            }
        }
        return pollIntervalMs;
    };

    const fetchDifference = (entity: Api.Channel, pts: number, limit: number, force: boolean) =>
        client.invoke(
            new Api.updates.GetChannelDifference({
                channel: entity,
                filter: new Api.ChannelMessagesFilterEmpty(),
                pts,
                limit,
                ...(force ? { force: true } : {})
            })
        );

    const syncChannelDifference = async (
        channelId: number,
        entity: Api.Channel,
        pts: number,
        limit: number,
        force: boolean,
        mode: IngestMode
    ): Promise<number> => {
        let currentPts = pts;
        let delayMs = pollIntervalMs;

        while (true) {
            const diff = await fetchDifference(entity, currentPts, limit, force);
            delayMs = applyDifference(channelId, diff, mode);
            currentPts = channelPts.get(channelId) ?? currentPts;

            if (!(diff instanceof Api.updates.ChannelDifference) || diff.final !== false) {
                return delayMs;
            }
        }
    };

    const noteFloodWait = (error: unknown) => {
        const waitSec = parseFloodWaitSeconds(error);
        if (waitSec == null) return;
        const until = Date.now() + waitSec * 1000;
        if (until > globalPollPausedUntil) {
            globalPollPausedUntil = until;
            logger.warn('MTProto poll paused for flood wait', undefined, { waitSec });
        }
    };

    const noteOutdatedBackoff = (channelId: number, streak: number) => {
        const backoffMs = Math.min(
            OUTDATED_BACKOFF_CAP_MS,
            OUTDATED_BACKOFF_START_MS * 2 ** Math.max(0, streak - 1)
        );
        channelPollDelayMs.set(channelId, Math.max(pollIntervalMs, backoffMs));
        channelNextPollAt.set(channelId, Date.now() + backoffMs);
    };

    const shouldForceOrResync = (channelId: number, streak: number): boolean => {
        if (streak >= OUTDATED_FORCE_MIN_STREAK) return true;
        const lastOk = lastSuccessfulDiffAt.get(channelId) ?? 0;
        return Date.now() - lastOk >= NO_DIFF_RESYNC_MS;
    };

    const subscribe = async (channel: { id: number; link: string; telegramPeerId: string | null }) => {
        if (channelEntities.has(channel.id)) return;
        const username = channelUsername(channel.link);
        if (!username) return;
        const entity = await client.getEntity(username);
        if (!(entity instanceof Api.Channel) || entity.id == null) return;

        try {
            await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/USER_ALREADY_PARTICIPANT/i.test(message)) {
                logger.warn('MTProto join failed', channel.id, { username, error: message });
            }
        }

        const peerId = channel.telegramPeerId || resolvePeerIdFromEntity(entity);
        if (peerId !== channel.telegramPeerId) {
            await prisma.channel.update({ where: { id: channel.id }, data: { telegramPeerId: peerId } });
        }
        remember({ channelId: channel.id, username, peerId });

        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
        const pts = 'pts' in full.fullChat ? Number(full.fullChat.pts) : 1;
        channelEntities.set(channel.id, entity);
        setChannelPts(channel.id, pts);

        const delayMs = await syncChannelDifference(
            channel.id,
            entity,
            pts,
            SUBSCRIBE_DIFFERENCE_LIMIT,
            true,
            'historical'
        );
        channelPollDelayMs.set(channel.id, delayMs);
        channelNextPollAt.set(channel.id, Date.now() + delayMs);
        lastSuccessfulDiffAt.set(channel.id, Date.now());

        logger.info('MTProto channel pts subscribed', channel.id, {
            username,
            pts: channelPts.get(channel.id),
            nextPollMs: delayMs
        });
    };

    const syncChannels = async () => {
        const channels = await prisma.channel.findMany({
            select: { id: true, link: true, telegramPeerId: true }
        });
        const pending = channels.filter(channel => !channelEntities.has(channel.id));
        await runWithConcurrency(pending, pollConcurrency, async channel => {
            try {
                await subscribe(channel);
            } catch (error) {
                logger.warn('MTProto cannot subscribe channel', channel.id, {
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        });
    };

    client.addEventHandler(async (update: Api.TypeUpdate) => {
        const channelUpdates = collectChannelMessageUpdates(update);
        if (channelUpdates.length === 0) return;

        try {
            for (const channelUpdate of channelUpdates) {
                if (!(channelUpdate.message instanceof Api.Message) || !channelUpdate.message.peerId) continue;
                const peerId = utils.getPeerId(channelUpdate.message.peerId).toString();
                const mapping = peerToChannel.get(peerId);
                if (mapping) {
                    setChannelPts(mapping.channelId, channelUpdate.pts);
                    bumpPollAfterLivePush(mapping.channelId);
                    ingest(channelUpdate.message, mapping, 'live');
                }
            }
        } catch (error) {
            logger.error('MTProto raw update failed', undefined, { error });
        }
    }, new Raw({}));

    await syncChannels();
    logger.info('MTProto channel difference poll started', undefined, {
        channels: channelMappings.size,
        pollConcurrency,
        pollIntervalMs
    });

    const resyncChannel = async (channelId: number, entity: Api.Channel) => {
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
        const freshPts = 'pts' in full.fullChat ? Number(full.fullChat.pts) : undefined;
        const history = await client.invoke(
            new Api.messages.GetHistory({
                peer: entity,
                limit: RESYNC_HISTORY_LIMIT
            })
        );
        const messages = 'messages' in history ? history.messages : [];
        for (const message of messages) {
            if (message instanceof Api.Message) ingestFromMessage(message, 'historical');
        }
        if (freshPts != null) setChannelPts(channelId, freshPts);
        lastSuccessfulDiffAt.set(channelId, Date.now());
        outdatedStreak.delete(channelId);
        logger.info('MTProto channel resynced', channelId, { pts: freshPts, messages: messages.length });
    };

    const pollChannel = async (mapping: ChannelMapping, entity: Api.Channel, pts: number) => {
        try {
            const delayMs = await syncChannelDifference(
                mapping.channelId,
                entity,
                pts,
                HOT_DIFFERENCE_LIMIT,
                false,
                'live'
            );
            channelPollDelayMs.set(mapping.channelId, delayMs);
            return;
        } catch (error) {
            noteFloodWait(error);
            if (!isPtsOutdated(error)) {
                logger.warn('MTProto channel poll failed', mapping.channelId, {
                    username: mapping.username,
                    error: error instanceof Error ? error.message : String(error)
                });
                return;
            }
        }

        const streak = (outdatedStreak.get(mapping.channelId) ?? 0) + 1;
        outdatedStreak.set(mapping.channelId, streak);
        noteOutdatedBackoff(mapping.channelId, streak);

        if (!shouldForceOrResync(mapping.channelId, streak)) {
            logger.debug('MTProto poll early (pts outdated), backing off', mapping.channelId, {
                username: mapping.username,
                pts,
                streak
            });
            return;
        }

        if (Date.now() < (resyncNotBefore.get(mapping.channelId) ?? 0)) return;

        logger.warn('MTProto pts outdated, forcing difference', mapping.channelId, {
            username: mapping.username,
            pts,
            streak
        });
        try {
            const delayMs = await syncChannelDifference(
                mapping.channelId,
                entity,
                channelPts.get(mapping.channelId) ?? pts,
                HOT_DIFFERENCE_LIMIT,
                true,
                'live'
            );
            channelPollDelayMs.set(mapping.channelId, delayMs);
            return;
        } catch (error) {
            noteFloodWait(error);
            if (!isPtsOutdated(error)) {
                logger.warn('MTProto forced difference failed', mapping.channelId, {
                    username: mapping.username,
                    error: error instanceof Error ? error.message : String(error)
                });
                return;
            }
        }

        const forceStreak = (outdatedStreak.get(mapping.channelId) ?? 0) + 1;
        outdatedStreak.set(mapping.channelId, forceStreak);
        noteOutdatedBackoff(mapping.channelId, forceStreak);

        if (!shouldForceOrResync(mapping.channelId, forceStreak)) return;

        resyncNotBefore.set(mapping.channelId, Date.now() + RESYNC_COOLDOWN_MS);
        try {
            await resyncChannel(mapping.channelId, entity);
            channelPollDelayMs.set(mapping.channelId, pollIntervalMs);
        } catch (error) {
            noteFloodWait(error);
            logger.warn('MTProto channel resync failed', mapping.channelId, {
                username: mapping.username,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    };

    const schedulePoll = (mapping: ChannelMapping) => {
        const entity = channelEntities.get(mapping.channelId);
        const pts = channelPts.get(mapping.channelId);
        if (!entity || pts == null) return;
        if (pollInFlight.has(mapping.channelId)) return;

        pollInFlight.add(mapping.channelId);
        void pollChannel(mapping, entity, pts)
            .catch(error => {
                noteFloodWait(error);
                logger.warn('MTProto poll task failed', mapping.channelId, {
                    username: mapping.username,
                    error: error instanceof Error ? error.message : String(error)
                });
            })
            .finally(() => {
                pollInFlight.delete(mapping.channelId);
                const delay = channelPollDelayMs.get(mapping.channelId) ?? pollIntervalMs;
                const scheduledAt = channelNextPollAt.get(mapping.channelId) ?? 0;
                const fromNow = Date.now() + delay;
                if (fromNow > scheduledAt) channelNextPollAt.set(mapping.channelId, fromNow);
            });
    };

    const poll = async () => {
        while (running) {
            const now = Date.now();
            if (now >= globalPollPausedUntil) {
                const due: ChannelMapping[] = [];
                for (const mapping of channelMappings.values()) {
                    if (pollInFlight.has(mapping.channelId)) continue;
                    const nextAt = channelNextPollAt.get(mapping.channelId) ?? 0;
                    if (nextAt <= now) due.push(mapping);
                }
                due.sort(
                    (a, b) =>
                        (channelNextPollAt.get(a.channelId) ?? 0) - (channelNextPollAt.get(b.channelId) ?? 0)
                );
                for (const mapping of due) {
                    if (pollInFlight.size >= pollConcurrency) break;
                    schedulePoll(mapping);
                }
            }
            await new Promise(resolve => setTimeout(resolve, POLL_TICK_MS));
        }
    };
    void poll();

    setInterval(() => {
        void client.invoke(new Api.updates.GetState()).catch(error => {
            logger.warn('MTProto keepalive failed', undefined, { error });
        });
    }, KEEP_ALIVE_MS);

    setInterval(() => {
        void syncChannels().catch(error => logger.error('MTProto channel sync failed', undefined, { error }));
    }, CHANNEL_REFRESH_MS);
}
