import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events';
import { UpdateConnectionState } from 'telegram/network';
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

const KEEP_ALIVE_MS = 30_000;
const RECONNECT_MS = 30_000;
const RAW_UPDATE_LOG_LIMIT = 40;

export class TelegramListener {
    private client: TelegramClient | null = null;
    private healthy = false;
    private connecting = false;
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
    private rawUpdateLogs = 0;

    constructor(private readonly processor: MessageProcessor) {
        this.boundHandler = (event) => this.handleNewMessage(event);
    }

    isHealthy(): boolean {
        return this.healthy;
    }

    getLastMessageAt(): number {
        return this.lastMessageAt;
    }

    getWatchedChannelCount(): number {
        return this.watchedChannelCount;
    }

    async start(): Promise<void> {
        try {
            await this.connect();
        } catch (err) {
            this.healthy = false;
            throw err;
        }
        this.reconnectTimer = setInterval(() => {
            if (!this.healthy && !this.connecting) {
                void this.connect().catch(err =>
                    logger.error('MTProto reconnect failed', undefined, { error: err })
                );
            }
        }, RECONNECT_MS);
    }

    private markUnhealthy(reason: string): void {
        if (!this.healthy) return;
        this.healthy = false;
        this.stopKeepAlive();
        logger.warn('MTProto marked unhealthy', undefined, { reason });
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
            void this.runKeepAlive().catch(err => {
                logger.warn('MTProto keepalive failed', undefined, { error: err });
                this.markUnhealthy('keepalive failed');
            });
        }, KEEP_ALIVE_MS);
    }

    private async runKeepAlive(): Promise<void> {
        if (!this.client) return;
        if (!this.client.connected) {
            this.markUnhealthy('socket not connected');
            return;
        }
        await this.client.invoke(new Api.updates.GetState());
    }

    private async connect(): Promise<void> {
        if (this.connecting) return;
        this.connecting = true;
        this.healthy = false;
        this.stopKeepAlive();

        try {
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
            this.rawUpdateLogs = 0;
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
            await this.client.invoke(new Api.updates.GetState());

            const saved = session.save();
            if (saved && saved !== sessionStr) {
                persistSession(saved);
            }

            this.healthy = true;
            this.startKeepAlive();
            logger.info(`MTProto listener connected, watching ${this.watchedChannelCount} channel(s)`);
        } finally {
            this.connecting = false;
        }
    }

    private registerChannelPeer(mapping: ChannelMapping): void {
        for (const alias of peerIdAliases(mapping.peerId)) {
            this.peerToChannel.set(alias, mapping);
        }
        if (!this.watchedPeerIds.includes(mapping.peerId)) {
            this.watchedPeerIds.push(mapping.peerId);
        }
    }

    private mappingFromPeerId(peerId: string | undefined): ChannelMapping | undefined {
        if (!peerId) return undefined;
        return this.peerToChannel.get(peerId);
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
                await this.subscribeChannelPts(entity, ch.id, username);

                logger.info(`MTProto watching @${username}`, ch.id, { telegramPeerId: peerId });
            } catch (err) {
                logger.error(`Failed to subscribe MTProto channel @${username}`, ch.id, { error: err });
            }
        }

        if (this.watchedChannelCount === 0) {
            throw new Error('No channels could be registered for MTProto ingest');
        }
    }

    private async subscribeChannelPts(
        entity: Api.TypeEntityLike,
        channelId: number,
        username: string
    ): Promise<void> {
        if (!this.client) return;
        try {
            const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
            const pts = 'pts' in full.fullChat ? Number(full.fullChat.pts) : 1;
            const diff = await this.client.invoke(new Api.updates.GetChannelDifference({
                channel: entity,
                filter: new Api.ChannelMessagesFilterEmpty(),
                pts,
                limit: 100,
                force: true
            }));
            logger.info('MTProto channel pts subscribed', channelId, {
                username: `@${username}`,
                pts,
                difference: diff.className
            });
        } catch (err) {
            logger.warn('MTProto GetChannelDifference failed', channelId, {
                username: `@${username}`,
                error: err
            });
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

        this.client.addEventHandler(this.boundHandler, new NewMessage({}));
        this.client.addEventHandler((update: unknown) => {
            void this.onRawUpdate(update);
        }, new Raw({}));
        this.handlerRegistered = true;
    }

    private async onRawUpdate(update: unknown): Promise<void> {
        if (update instanceof UpdateConnectionState) {
            if (update.state === UpdateConnectionState.connected) {
                if (!this.healthy && this.client?.connected) {
                    this.healthy = true;
                    this.startKeepAlive();
                    logger.info('MTProto connection restored');
                }
                return;
            }
            this.markUnhealthy(`connection state ${update.state}`);
            return;
        }

        const className =
            update && typeof update === 'object' && 'className' in update
                ? String((update as { className?: string }).className)
                : update?.constructor?.name;

        if (this.rawUpdateLogs < RAW_UPDATE_LOG_LIMIT) {
            this.rawUpdateLogs++;
            logger.info('MTProto raw update', undefined, { className, n: this.rawUpdateLogs });
        }

        if (className === 'UpdatesTooLong') {
            await this.fetchAccountDifference();
            return;
        }

        if (
            update instanceof Api.UpdateNewChannelMessage ||
            update instanceof Api.UpdateNewMessage
        ) {
            const message = update.message;
            if (message instanceof Api.Message) {
                await this.ingestApiMessage(message);
            }
        }
    }

    private async fetchAccountDifference(): Promise<void> {
        if (!this.client) return;
        try {
            const state = await this.client.invoke(new Api.updates.GetState());
            await this.client.invoke(new Api.updates.GetDifference({
                pts: state.pts,
                date: state.date,
                qts: state.qts
            }));
            logger.info('MTProto fetched account difference', undefined, { pts: state.pts });
        } catch (err) {
            logger.warn('MTProto GetDifference failed', undefined, { error: err });
        }
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
        return this.mappingFromPeerId(peerId);
    }

    private async handleNewMessage(event: NewMessageEvent): Promise<void> {
        try {
            if (!event.isChannel) return;
            await this.ingestApiMessage(event.message);
        } catch (err) {
            logger.error('MTProto message handler error', undefined, { error: err });
        }
    }

    private async ingestApiMessage(msg: Api.Message): Promise<void> {
        try {
            if (!msg.peerId) return;
            const peerId = utils.getPeerId(msg.peerId).toString();
            const mapping = this.mappingFromPeerId(peerId);
            if (!mapping) {
                logger.warn('MTProto message from unmapped channel', undefined, {
                    peerId,
                    knownPeerIds: this.watchedPeerIds
                });
                return;
            }

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
            logger.error('MTProto ingest error', undefined, { error: err });
        }
    }
}
