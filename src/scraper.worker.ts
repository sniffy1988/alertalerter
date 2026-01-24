import { parentPort, workerData } from 'worker_threads';
import axios from 'axios';
import * as cheerio from 'cheerio';

// Types (replicated here or imported if shared)
interface ScrapedMessage {
    telegramId: number;
    text: string;
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
        const text = msgNode.find('.tgme_widget_message_text').text().trim();
        const timeStr = msgNode.find('time').attr('datetime');

        if (!text && !msgNode.find('.tgme_widget_message_photo').length) return;
        if (!timeStr) return;

        messages.push({
            telegramId: messageId,
            text: text,
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
