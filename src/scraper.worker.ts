import { parentPort, workerData } from 'worker_threads';
import axios from 'axios';
import * as cheerio from 'cheerio';

// Types (replicated here or imported if shared)
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
}

interface WorkerResult {
    success: boolean;
    channelId: number;
    username: string;
    messages?: ScrapedMessage[];
    error?: any;
    log?: string;
}

// Function to scrape a single channel
async function scrapeChannel(username: string): Promise<ScrapedMessage[]> {
    const url = `https://t.me/s/${username}`;
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
        timeout: 10000
    });

    const $ = cheerio.load(response.data as string);
    const messages: ScrapedMessage[] = [];

    $('.tgme_widget_message_wrap').each((_, element) => {
        const msgNode = $(element).find('.tgme_widget_message');
        const dataId = msgNode.attr('data-post');

        if (!dataId) return;

        const messageId = parseInt(dataId.split('/').pop() || '0', 10);

        // Find text node and strip citations/replies
        const textNode = msgNode.find('.tgme_widget_message_text.js-message_text');
        textNode.find('.tgme_widget_message_reply').remove();
        textNode.find('.tgme_widget_message_author_name').remove();

        // Preserve line breaks
        textNode.find('br').replaceWith('\n');

        const text = textNode.text().trim();
        const timeStr = msgNode.find('time').attr('datetime');

        if (!text && !msgNode.find('.tgme_widget_message_photo').length && !msgNode.find('.tgme_widget_message_video').length) return;
        if (!timeStr) return;

        let mediaUrl: string | undefined;
        let mediaType: 'photo' | 'video' | undefined;

        // Try to find photo
        const photoNode = msgNode.find('.tgme_widget_message_photo_wrap');
        if (photoNode.length) {
            const style = photoNode.attr('style');
            const match = style?.match(/background-image:url\(['"](.+?)['"]\)/);
            if (match && match[1]) {
                mediaUrl = match[1];
                mediaType = 'photo';
            }
        }

        // Try to find video
        if (!mediaUrl) {
            const videoNode = msgNode.find('.tgme_widget_message_video');
            if (videoNode.length) {
                // Usually video is behind a link or in a video tag
                const videoTag = videoNode.find('video');
                if (videoTag.length) {
                    mediaUrl = videoTag.attr('src');
                    mediaType = 'video';
                } else {
                    // Sometimes it's just a class with a background image preview
                    // For truly obtaining video we would need the direct link, but let's try the preview for now or common patterns
                    mediaUrl = videoNode.attr('src'); // Check if src is directly there
                    if (!mediaUrl) {
                        const style = videoNode.attr('style');
                        const match = style?.match(/background-image:url\(['"](.+?)['"]\)/);
                        if (match && match[1]) {
                            mediaUrl = match[1];
                            mediaType = 'video'; // Mark as video even if we only have preview
                        }
                    }
                }
            }
        }

        messages.push({
            telegramId: messageId,
            text: text,
            mediaUrl,
            mediaType,
            date: new Date(timeStr),
            sender: msgNode.find('.tgme_widget_message_from_author').text().trim() || undefined,
        });
    });

    return messages;
}

// Listen for messages from the main thread
if (parentPort) {
    parentPort.on('message', async (job: WorkerJob) => {
        try {
            const messages = await scrapeChannel(job.username);
            const result: WorkerResult = {
                success: true,
                channelId: job.channelId,
                username: job.username,
                messages
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
