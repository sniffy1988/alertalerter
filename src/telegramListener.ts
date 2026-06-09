import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { Api } from 'telegram/tl';
import { utils } from 'telegram';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor, type IncomingMessage } from './messageProcessor';
import {
    getApiCredentials,
    loadSessionString,
    persistSession
} from './telegramConfig';

type ChannelMapping = { channelId: number; username: string };

export class TelegramListener {
    private client: TelegramClient | null = null;
    private healthy = false;
    private reconnectTimer: ReturnType<typeof setInterval> | null = null;
    private readonly peerToChannel = new Map<string, ChannelMapping>();
    private watchedPeerIds: string[] = [];
    private handlerRegistered = false;
    private readonly groupedSeen = new Set<string>();
    private readonly boundHandler: (event: NewMessageEvent) => Promise<void>;

    constructor(private readonly processor: MessageProcessor) {
        this.boundHandler = (event) => this.handleNewMessage(event);
    }

    isHealthy(): boolean {
        return this.healthy;
    }

    async start(): Promise<void> {
        try {
            await this.connect();
        } catch (err) {
            this.healthy = false;
            throw err;
        }
        this.reconnectTimer = setInterval(() => {
            if (!this.healthy) {
                void this.connect().catch(err =>
                    logger.error('MTProto reconnect failed', undefined, { error: err })
                );
            }
        }, 30_000);
    }

    private async connect(): Promise<void> {
        this.healthy = false;
        const { apiId, apiHash } = getApiCredentials();
        const sessionStr = loadSessionString();
        const session = new StringSession(sessionStr);

        if (this.client) {
            try {
                await this.client.disconnect();
            } catch {
                // ignore stale disconnect
            }
        }

        this.handlerRegistered = false;
        this.client = new TelegramClient(session, apiId, apiHash, {
            connectionRetries: 5
        });

        await this.client.connect();

        if (!(await this.client.checkAuthorization())) {
            throw new Error(
                'Telegram user session is not authorized. Run: npm run telegram:auth'
            );
        }

        await this.setupChannels();
        this.registerHandler();

        const saved = session.save();
        if (saved && saved !== sessionStr) {
            persistSession(saved);
        }

        this.healthy = true;
        logger.info(`MTProto listener connected, watching ${this.peerToChannel.size} channel(s)`);
    }

    private async setupChannels(): Promise<void> {
        if (!this.client) return;

        this.peerToChannel.clear();
        this.watchedPeerIds = [];

        const channels = await prisma.channel.findMany({
            select: { id: true, link: true }
        });

        for (const ch of channels) {
            const username = ch.link.split('/').pop()?.replace('@', '') || ch.link;
            try {
                const entity = await this.client.getEntity(username);
                await this.tryJoinChannel(entity);

                const peerId = utils.getPeerId(entity).toString();
                this.peerToChannel.set(peerId, { channelId: ch.id, username });
                this.watchedPeerIds.push(peerId);

                logger.info(`MTProto watching @${username}`, ch.id);
            } catch (err) {
                logger.error(`Failed to subscribe MTProto channel @${username}`, ch.id, { error: err });
            }
        }

        if (this.peerToChannel.size === 0) {
            throw new Error('No channels could be registered for MTProto ingest');
        }
    }

    private async tryJoinChannel(entity: Api.TypeEntityLike): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.invoke(new Api.channels.JoinChannel({ channel: entity }));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('USER_ALREADY_PARTICIPANT')) {
                throw err;
            }
        }
    }

    private registerHandler(): void {
        if (!this.client || this.handlerRegistered) return;

        this.client.addEventHandler(
            this.boundHandler,
            new NewMessage({ chats: this.watchedPeerIds })
        );
        this.handlerRegistered = true;
    }

    private async handleNewMessage(event: NewMessageEvent): Promise<void> {
        try {
            if (!event.isChannel) return;

            const chatId = event.chatId?.toString();
            if (!chatId) return;

            const mapping = this.peerToChannel.get(chatId);
            if (!mapping) return;

            const msg = event.message;
            if (msg.editDate) return;

            if (msg.groupedId) {
                const groupedKey = `${chatId}:${msg.groupedId.toString()}`;
                if (this.groupedSeen.has(groupedKey)) return;
                this.groupedSeen.add(groupedKey);
                if (this.groupedSeen.size > 1000) {
                    this.groupedSeen.clear();
                }
            }

            const text = msg.message || '';
            if (!text && !msg.media) return;

            const incoming: IncomingMessage = {
                telegramId: msg.id,
                text,
                date: new Date(msg.date * 1000)
            };

            await this.processor.processIncomingMessages(mapping.channelId, [incoming], 'mtproto');
        } catch (err) {
            logger.error('MTProto message handler error', undefined, { error: err });
        }
    }
}
