import { parentPort } from 'worker_threads';
import * as cheerio from 'cheerio';
import { fetchChannelHtml } from './telegramWebScrape';

type CheerioRoot = ReturnType<typeof cheerio.load>;

interface ScrapedMessage {
    telegramId: number;
    text: string;
    mediaUrl?: string;
    mediaType?: 'photo' | 'video';
    date: Date;
    sender?: string;
}

interface WorkerJob {
    username: string;
    channelId: number;
    afterTelegramId?: number;
}

interface WorkerResult {
    success: boolean;
    channelId: number;
    username: string;
    messages?: ScrapedMessage[];
    maxTelegramId?: number;
    error?: any;
    log?: string;
}

function parseMessageId($: CheerioRoot, element: any): number | null {
    const dataId = $(element).find('.tgme_widget_message').attr('data-post');
    if (!dataId) return null;
    const messageId = parseInt(dataId.split('/').pop() || '0', 10);
    return Number.isFinite(messageId) && messageId > 0 ? messageId : null;
}

function parseMessage($: CheerioRoot, element: any, messageId: number): ScrapedMessage | null {
    const msgNode = $(element).find('.tgme_widget_message');

    const textNode = msgNode.find('.tgme_widget_message_text.js-message_text');
    textNode.find('.tgme_widget_message_reply').remove();
    textNode.find('.tgme_widget_message_author_name').remove();
    textNode.find('br').replaceWith('\n');

    const text = textNode.text().trim();
    const timeStr = msgNode.find('time').attr('datetime');

    if (!text && !msgNode.find('.tgme_widget_message_photo').length && !msgNode.find('.tgme_widget_message_video').length) return null;
    if (!timeStr) return null;

    let mediaUrl: string | undefined;
    let mediaType: 'photo' | 'video' | undefined;

    const photoNode = msgNode.find('.tgme_widget_message_photo_wrap');
    if (photoNode.length) {
        const style = photoNode.attr('style');
        const match = style?.match(/background-image:url\(['"](.+?)['"]\)/);
        if (match && match[1]) {
            mediaUrl = match[1];
            mediaType = 'photo';
        }
    }

    if (!mediaUrl) {
        const videoNode = msgNode.find('.tgme_widget_message_video');
        if (videoNode.length) {
            const videoTag = videoNode.find('video');
            if (videoTag.length) {
                mediaUrl = videoTag.attr('src');
                mediaType = 'video';
            } else {
                mediaUrl = videoNode.attr('src');
                if (!mediaUrl) {
                    const style = videoNode.attr('style');
                    const match = style?.match(/background-image:url\(['"](.+?)['"]\)/);
                    if (match && match[1]) {
                        mediaUrl = match[1];
                        mediaType = 'video';
                    }
                }
            }
        }
    }

    return {
        telegramId: messageId,
        text,
        mediaUrl,
        mediaType,
        date: new Date(timeStr),
        sender: msgNode.find('.tgme_widget_message_from_author').text().trim() || undefined,
    };
}

async function scrapeChannel(username: string, afterTelegramId?: number): Promise<{ messages: ScrapedMessage[]; maxTelegramId?: number }> {
    const html = await fetchChannelHtml(username);
    const $ = cheerio.load(html);
    const wraps = $('.tgme_widget_message_wrap').toArray();
    if (wraps.length === 0) return { messages: [] };

    const firstId = parseMessageId($, wraps[0]);
    const lastId = parseMessageId($, wraps[wraps.length - 1]);
    const newestFirst = firstId != null && lastId != null && firstId >= lastId;
    const ordered = newestFirst ? wraps : [...wraps].reverse();

    const messages: ScrapedMessage[] = [];
    let maxTelegramId = afterTelegramId ?? 0;

    for (const element of ordered) {
        const messageId = parseMessageId($, element);
        if (messageId == null) continue;
        if (messageId > maxTelegramId) maxTelegramId = messageId;
        if (afterTelegramId && messageId <= afterTelegramId) break;

        const parsed = parseMessage($, element, messageId);
        if (parsed) messages.push(parsed);
    }

    return {
        messages,
        maxTelegramId: maxTelegramId > 0 ? maxTelegramId : undefined
    };
}

if (parentPort) {
    parentPort.on('message', async (job: WorkerJob) => {
        try {
            const { messages, maxTelegramId } = await scrapeChannel(job.username, job.afterTelegramId);
            const result: WorkerResult = {
                success: true,
                channelId: job.channelId,
                username: job.username,
                messages,
                maxTelegramId
            };
            parentPort?.postMessage(result);
        } catch (error) {
            const result: WorkerResult = {
                success: false,
                channelId: job.channelId,
                username: job.username,
                error: (error as Error).message
            };
            parentPort?.postMessage(result);
        }
    });
}
