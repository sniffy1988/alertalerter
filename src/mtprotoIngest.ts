import fs from 'fs';
import { Api, TelegramClient } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { StringSession } from 'telegram/sessions';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor } from './messageProcessor';

const MAX_POST_AGE_MS = 120_000;
const CHANNEL_REFRESH_MS = 30_000;

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
    } catch (error) {
        logger.error('MTProto ingest failed to connect', undefined, { error });
        return;
    }

    const peerToChannel = new Map<string, number>();
    const watched = new Set<number>();
    const joined = new Set<string>();

    const syncChannels = async () => {
        const channels = await prisma.channel.findMany({ select: { id: true, link: true } });
        for (const channel of channels) {
            if (watched.has(channel.id)) continue;
            const username = channelUsername(channel.link);
            if (!username) continue;
            try {
                const entity = await client.getEntity(username);
                if (!(entity instanceof Api.Channel) || entity.id == null) continue;
                const raw = entity.id.toString();
                peerToChannel.set(raw, channel.id);
                peerToChannel.set(`-100${raw}`, channel.id);
                watched.add(channel.id);
                if (!joined.has(username)) {
                    try {
                        await client.invoke(new Api.channels.JoinChannel({ channel: username }));
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        if (!/ALREADY_PARTICIPANT/i.test(message)) {
                            logger.warn('MTProto join failed', channel.id, { username, error: message });
                        }
                    }
                    joined.add(username);
                }
                logger.info('MTProto watching channel', channel.id, { username });
            } catch (error) {
                logger.warn('MTProto cannot resolve channel', channel.id, {
                    username,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    };

    client.addEventHandler(async (event: NewMessageEvent) => {
        const msg = event.message;
        if (!msg || msg.action) return;
        const peer = msg.peerId;
        if (!(peer instanceof Api.PeerChannel)) return;

        const raw = peer.channelId.toString();
        const channelId = peerToChannel.get(raw) ?? peerToChannel.get(`-100${raw}`);
        if (!channelId) return;

        const postedAt = (msg.date ?? 0) * 1000;
        if (!postedAt || Date.now() - postedAt > MAX_POST_AGE_MS) return;

        const text = msg.message ?? '';
        if (!text.trim()) return;

        try {
            await processor.processIncomingMessages(channelId, [
                {
                    telegramId: msg.id,
                    text,
                    date: new Date(postedAt),
                    source: 'mtproto'
                }
            ]);
        } catch (error) {
            logger.error('MTProto message failed', channelId, { telegramId: msg.id, error });
        }
    }, new NewMessage({}));

    await syncChannels();
    setInterval(() => {
        void syncChannels().catch(error => logger.error('MTProto channel sync failed', undefined, { error }));
    }, CHANNEL_REFRESH_MS);
    logger.info('MTProto ingest on');
}
