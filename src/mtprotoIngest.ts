import fs from 'fs';
import { TelegramClient, utils } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events';
import { Api } from 'telegram/tl';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor, previewMessageText } from './messageProcessor';
import { peerIdAliases, resolvePeerIdFromEntity } from './telegramPeerId';

const MAX_POST_AGE_MS = 120_000;
const POLL_GAP_MS = 1_000;
const KEEP_ALIVE_MS = 30_000;
const CHANNEL_REFRESH_MS = 30_000;

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

export async function startMtprotoIngest(processor: MessageProcessor): Promise<void> {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH?.trim();
    const session = readSession();
    if (!apiId || !apiHash || !session) {
        logger.info('MTProto ingest off (no api id, hash, or user session)');
        return;
    }

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
    const groupedSeen = new Set<string>();
    let running = true;

    const remember = (mapping: ChannelMapping) => {
        channelMappings.set(mapping.channelId, mapping);
        for (const alias of peerIdAliases(mapping.peerId)) {
            peerToChannel.set(alias, mapping);
        }
    };

    const ingest = async (msg: Api.Message) => {
        if (!msg.peerId || msg.editDate) return;
        const peerId = utils.getPeerId(msg.peerId).toString();
        const mapping = peerToChannel.get(peerId);
        if (!mapping) return;

        const postedAt = (msg.date ?? 0) * 1000;
        if (!postedAt || Date.now() - postedAt > MAX_POST_AGE_MS) return;

        if (msg.groupedId) {
            const key = `${mapping.peerId}:${msg.groupedId.toString()}`;
            if (groupedSeen.has(key)) return;
            groupedSeen.add(key);
            if (groupedSeen.size > 1000) groupedSeen.clear();
        }

        const text = msg.message?.trim() ? msg.message : msg.media ? '(media)' : '';
        if (!text.trim()) return;

        logger.info('MTProto push received', mapping.channelId, {
            username: mapping.username,
            telegramId: msg.id,
            preview: previewMessageText(text)
        });
        await processor.processIncomingMessages(mapping.channelId, [
            {
                telegramId: msg.id,
                text,
                date: new Date(postedAt),
                source: 'mtproto'
            }
        ]);
    };

    const applyDifference = async (channelId: number, diff: Api.updates.TypeChannelDifference) => {
        if (diff instanceof Api.updates.ChannelDifferenceEmpty) {
            channelPts.set(channelId, Number(diff.pts));
            return;
        }
        if (diff instanceof Api.updates.ChannelDifference) {
            channelPts.set(channelId, Number(diff.pts));
            const messages = diff.newMessages ?? [];
            if (messages.length > 0) {
                logger.info('MTProto channel difference', channelId, { newMessages: messages.length, pts: Number(diff.pts) });
            }
            for (const message of messages) {
                if (message instanceof Api.Message) await ingest(message);
            }
            return;
        }
        if (diff instanceof Api.updates.ChannelDifferenceTooLong) {
            const dialogPts = diff.dialog && 'pts' in diff.dialog ? Number(diff.dialog.pts) : undefined;
            if (dialogPts != null) channelPts.set(channelId, dialogPts);
            logger.info('MTProto channel difference too long', channelId, { messages: diff.messages?.length ?? 0 });
            for (const message of diff.messages ?? []) {
                if (message instanceof Api.Message) await ingest(message);
            }
        }
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
        const diff = await client.invoke(
            new Api.updates.GetChannelDifference({
                channel: entity,
                filter: new Api.ChannelMessagesFilterEmpty(),
                pts,
                limit: 100,
                force: true
            })
        );
        channelEntities.set(channel.id, entity);
        channelPts.set(channel.id, 'pts' in diff ? Number(diff.pts) : pts);
        await applyDifference(channel.id, diff);
        logger.info('MTProto channel pts subscribed', channel.id, {
            username,
            pts: channelPts.get(channel.id),
            difference: diff.className
        });
    };

    const syncChannels = async () => {
        const channels = await prisma.channel.findMany({
            select: { id: true, link: true, telegramPeerId: true }
        });
        for (const channel of channels) {
            if (channelEntities.has(channel.id)) continue;
            try {
                await subscribe(channel);
            } catch (error) {
                logger.warn('MTProto cannot subscribe channel', channel.id, {
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    };

    client.addEventHandler(async (event: NewMessageEvent) => {
        if (!event.isChannel) return;
        try {
            await ingest(event.message);
        } catch (error) {
            logger.error('MTProto message failed', undefined, { error });
        }
    }, new NewMessage({}));

    client.addEventHandler(async (update: Api.TypeUpdate) => {
        if (!(update instanceof Api.UpdateNewChannelMessage) && !(update instanceof Api.UpdateNewMessage)) return;
        if (!(update.message instanceof Api.Message)) return;
        try {
            await ingest(update.message);
        } catch (error) {
            logger.error('MTProto raw update failed', undefined, { error });
        }
    }, new Raw({}));

    await syncChannels();
    logger.info('MTProto channel difference poll started', undefined, { channels: channelMappings.size });

    const poll = async () => {
        while (running) {
            for (const mapping of channelMappings.values()) {
                const entity = channelEntities.get(mapping.channelId);
                const pts = channelPts.get(mapping.channelId);
                if (!entity || pts == null) continue;
                try {
                    const diff = await client.invoke(
                        new Api.updates.GetChannelDifference({
                            channel: entity,
                            filter: new Api.ChannelMessagesFilterEmpty(),
                            pts,
                            limit: 100
                        })
                    );
                    await applyDifference(mapping.channelId, diff);
                } catch (error) {
                    logger.warn('MTProto channel poll failed', mapping.channelId, {
                        username: mapping.username,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
            await new Promise(resolve => setTimeout(resolve, POLL_GAP_MS));
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
