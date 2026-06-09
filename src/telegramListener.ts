import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { Api } from 'telegram/tl';
import { utils } from 'telegram';
import prisma from './db';
import { logger } from './logger';
import { MessageProcessor, type IncomingMessage, previewMessageText } from './messageProcessor';
import { peerIdAliases, resolvePeerIdFromEntity } from './telegramPeerId';
import {
    getApiCredentials,
    loadSessionString,
    persistSession
} from './telegramConfig';

type ChannelMapping = { channelId: number; username: string; peerId: string };

export class TelegramListener {
    private client: TelegramClient | null = null;
    private healthy = false;
    private reconnectTimer: ReturnType<typeof setInterval> | null = null;
    private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    private readonly peerToChannel = new Map<string, ChannelMapping>();
    private readonly channelMappings = new Map<number, ChannelMapping>();
    private watchedPeerIds: string[] = [];
    private watchedChannelCount = 0;
    private handlerRegistered = false;
    private readonly groupedSeen = new Set<string>();
    private readonly boundHandler: (event: NewMessageEvent) => Promise<void>;
    private lastMessageAt = 0;

    constructor(private readonly processor: MessageProcessor) {
        this.boundHandler = (event) => this.handleNewMessage(event);
    }

    isHealthy(): boolean {
        return this.healthy;
    }

    getLastMessageAt(): number {
        return this.lastMessageAt;
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

    private stopKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private startKeepAlive(): void {
        this.stopKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            void this.runKeepAlive().catch(err =>
                logger.warn('MTProto keepalive failed', undefined, { error: err })
            );
        }, 30_000);
    }

    private async runKeepAlive(): Promise<void> {
        if (!this.client || !this.healthy) return;

        await this.client.getDialogs({ limit: 100 });

        for (const mapping of this.channelMappings.values()) {
            await this.client.getEntity(mapping.username);
        }
    }

    private async connect(): Promise<void> {
        this.healthy = false;
        this.stopKeepAlive();

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

        await this.client.getMe();
        await this.client.getDialogs({ limit: 100 });

        await this.setupChannels();
        this.registerHandler();
        await this.runKeepAlive();

        const saved = session.save();
        if (saved && saved !== sessionStr) {
            persistSession(saved);
        }

        this.healthy = true;
        this.startKeepAlive();
        logger.info(`MTProto listener connected, watching ${this.watchedChannelCount} channel(s)`);
    }

    private registerChannelPeer(mapping: ChannelMapping): void {
        for (const alias of peerIdAliases(mapping.peerId)) {
            this.peerToChannel.set(alias, mapping);
        }
        if (!this.watchedPeerIds.includes(mapping.peerId)) {
            this.watchedPeerIds.push(mapping.peerId);
        }
    }

    private async setupChannels(): Promise<void> {
        if (!this.client) return;

        this.peerToChannel.clear();
        this.channelMappings.clear();
        this.watchedPeerIds = [];
        this.watchedChannelCount = 0;

        const channels = await prisma.channel.findMany({
            select: { id: true, link: true, telegramPeerId: true }
        });

        for (const ch of channels) {
            const username = ch.link.split('/').pop()?.replace('@', '') || ch.link;
            try {
                const entity = await this.client.getEntity(username);
                await this.tryJoinChannel(entity);

                const peerId = ch.telegramPeerId || resolvePeerIdFromEntity(entity);
                if (peerId !== ch.telegramPeerId) {
                    await prisma.channel.update({
                        where: { id: ch.id },
                        data: { telegramPeerId: peerId }
                    });
                }

                const mapping: ChannelMapping = { channelId: ch.id, username, peerId };
                this.channelMappings.set(ch.id, mapping);
                this.registerChannelPeer(mapping);
                this.watchedChannelCount++;

                logger.info(`MTProto watching @${username}`, ch.id, { telegramPeerId: peerId });
            } catch (err) {
                logger.error(`Failed to subscribe MTProto channel @${username}`, ch.id, { error: err });
            }
        }

        if (this.watchedChannelCount === 0) {
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
            new NewMessage({ incoming: true, chats: this.watchedPeerIds })
        );
        this.handlerRegistered = true;
    }

    private resolveMapping(event: NewMessageEvent): ChannelMapping | undefined {
        const chatId = event.chatId?.toString();
        if (chatId) {
            const byChatId = this.peerToChannel.get(chatId);
            if (byChatId) return byChatId;
        }

        const peerId = event.message.peerId
            ? utils.getPeerId(event.message.peerId).toString()
            : undefined;
        if (peerId) {
            const byPeer = this.peerToChannel.get(peerId);
            if (byPeer) return byPeer;
        }

        return undefined;
    }

    private async handleNewMessage(event: NewMessageEvent): Promise<void> {
        try {
            if (!event.isChannel) return;

            const mapping = this.resolveMapping(event);
            if (!mapping) {
                logger.warn('MTProto message from unmapped channel', undefined, {
                    chatId: event.chatId?.toString(),
                    peerId: event.message.peerId
                        ? utils.getPeerId(event.message.peerId).toString()
                        : undefined,
                    knownPeerIds: this.watchedPeerIds
                });
                return;
            }

            const msg = event.message;
            if (msg.editDate) return;

            if (msg.groupedId) {
                const groupedKey = `${mapping.peerId}:${msg.groupedId.toString()}`;
                if (this.groupedSeen.has(groupedKey)) return;
                this.groupedSeen.add(groupedKey);
                if (this.groupedSeen.size > 1000) {
                    this.groupedSeen.clear();
                }
            }

            let text = msg.message || '';
            if (!text && msg.media) {
                text = '(media)';
            }
            if (!text) return;

            this.lastMessageAt = Date.now();

            const incoming: IncomingMessage = {
                telegramId: msg.id,
                text,
                date: new Date(msg.date * 1000)
            };

            logger.info('MTProto push received', mapping.channelId, {
                channel: `@${mapping.username}`,
                telegramId: msg.id,
                preview: previewMessageText(text)
            });

            await this.processor.processIncomingMessages(mapping.channelId, [incoming], 'mtproto');
        } catch (err) {
            logger.error('MTProto message handler error', undefined, { error: err });
        }
    }
}
