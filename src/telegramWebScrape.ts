import http from 'http';
import https from 'https';
import axios from 'axios';
import { isMainThread, workerData } from 'worker_threads';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const axiosInstance = axios.create({
    timeout: 5000,
    headers: { 'User-Agent': USER_AGENT },
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true })
} as Parameters<typeof axios.create>[0]);

export const TELEGRAM_WEB_HOSTS = ['t.me', 'telegram.me'] as const;
export type TelegramWebHost = (typeof TELEGRAM_WEB_HOSTS)[number];

function isTelegramWebHost(value: unknown): value is TelegramWebHost {
    return value === 't.me' || value === 'telegram.me';
}

let preferredHost: TelegramWebHost | null =
    !isMainThread && isTelegramWebHost(workerData?.preferredHost) ? workerData.preferredHost : null;

export function getPreferredHost(): TelegramWebHost | null {
    return preferredHost;
}

export function setPreferredHost(host: TelegramWebHost): void {
    preferredHost = host;
}

export function channelPreviewUrl(host: TelegramWebHost, username: string): string {
    return `https://${host}/s/${username}`;
}

function hostsInOrder(): TelegramWebHost[] {
    if (!preferredHost) return [...TELEGRAM_WEB_HOSTS];
    return [preferredHost, ...TELEGRAM_WEB_HOSTS.filter(h => h !== preferredHost)];
}

function isRetryable(err: unknown): boolean {
    const e = err as { response?: { status?: number }; code?: string };
    if (e && typeof e === 'object') {
        const status = e.response?.status;
        if (status === 429) return true;
        if (status != null && status >= 500 && status < 600) return true;
        if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') return true;
    }
    return err instanceof Error && (('code' in err) || err.message.includes('timeout'));
}

function formatFetchError(err: unknown): string {
    const e = err as { response?: { status?: number }; code?: string; message?: string };
    if (e?.response?.status != null) return `HTTP ${e.response.status}`;
    if (e?.code) return e.code;
    if (err instanceof Error) return err.message;
    return String(err);
}

async function fetchWithRetry(url: string, maxAttempts = 3): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await axiosInstance.get(url);
            return response.data as string;
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts && isRetryable(err)) {
                await new Promise(r => setTimeout(r, 200 * attempt));
            } else {
                throw err;
            }
        }
    }
    throw lastError;
}

export async function fetchChannelHtml(username: string): Promise<string> {
    let lastError: unknown;
    for (const host of hostsInOrder()) {
        try {
            const html = await fetchWithRetry(channelPreviewUrl(host, username));
            if (preferredHost !== host) setPreferredHost(host);
            return html;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

export type TelegramWebProbeAttempt = {
    host: TelegramWebHost;
    ok: boolean;
    error?: string;
};

export type TelegramWebProbeResult = {
    workingHost: TelegramWebHost | null;
    attempts: TelegramWebProbeAttempt[];
};

export async function probeTelegramWebScrape(
    testUsername = 'telegram'
): Promise<TelegramWebProbeResult> {
    const attempts: TelegramWebProbeAttempt[] = [];

    for (const host of TELEGRAM_WEB_HOSTS) {
        try {
            const response = await axiosInstance.get(channelPreviewUrl(host, testUsername));
            const html = response.data;
            if (typeof html === 'string' && html.includes('tgme_widget_message')) {
                attempts.push({ host, ok: true });
                setPreferredHost(host);
                return { workingHost: host, attempts };
            }
            attempts.push({ host, ok: false, error: 'unexpected response' });
        } catch (err) {
            attempts.push({ host, ok: false, error: formatFetchError(err) });
        }
    }

    return { workingHost: null, attempts };
}
