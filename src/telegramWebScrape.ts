import { Client, fetch as undiciFetch } from 'undici';
import { isMainThread, workerData } from 'worker_threads';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const REQUEST_TIMEOUT_MS = 2500;

export const TELEGRAM_WEB_HOSTS = ['t.me', 'telegram.me'] as const;
export type TelegramWebHost = (typeof TELEGRAM_WEB_HOSTS)[number];

type HttpError = Error & { response?: { status: number }; code?: string };

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

function errorCode(err: unknown): string | undefined {
    if (!err || typeof err !== 'object') return undefined;
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
}

function formatFetchError(err: unknown): string {
    const e = err as HttpError;
    if (e?.response?.status != null) return `HTTP ${e.response.status}`;
    const code = errorCode(err);
    if (code) return code;
    if (err instanceof Error) return err.message;
    return String(err);
}

function statusError(status: number): HttpError {
    const err = new Error(`HTTP ${status}`) as HttpError;
    err.response = { status };
    return err;
}

function normalizeTransportError(err: unknown): HttpError {
    const code = errorCode(err);
    if (code && code.includes('TIMEOUT')) {
        const timeout = new Error('timeout') as HttpError;
        timeout.code = 'ETIMEDOUT';
        return timeout;
    }
    if (err instanceof Error) return err as HttpError;
    return new Error(String(err)) as HttpError;
}

function isConnectionError(err: unknown): boolean {
    const code = errorCode(err) ?? '';
    return code === 'ECONNRESET'
        || code === 'ECONNREFUSED'
        || code === 'EPIPE'
        || code === 'UND_ERR_SOCKET'
        || code === 'UND_ERR_CLOSED'
        || code.startsWith('ERR_HTTP2_');
}

async function requestOnce(url: string): Promise<string> {
    const client = new Client(new URL(url).origin, {
        allowH2: true,
        connectTimeout: REQUEST_TIMEOUT_MS,
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS
    });
    try {
        let response: Awaited<ReturnType<typeof undiciFetch>>;
        try {
            response = await undiciFetch(url, {
                dispatcher: client,
                headers: {
                    'user-agent': USER_AGENT
                }
            });
        } catch (err) {
            throw normalizeTransportError(err);
        }

        if (response.status < 200 || response.status >= 300) {
            await response.body?.cancel().catch(() => undefined);
            throw statusError(response.status);
        }
        return await response.text();
    } finally {
        await client.close().catch(() => undefined);
    }
}

async function request(url: string): Promise<string> {
    try {
        return await requestOnce(url);
    } catch (err) {
        if (!isConnectionError(err)) throw err;
        return await requestOnce(url);
    }
}

export async function fetchChannelHtml(username: string): Promise<string> {
    let lastError: unknown;
    for (const host of hostsInOrder()) {
        try {
            const html = await request(channelPreviewUrl(host, username));
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
            const html = await request(channelPreviewUrl(host, testUsername));
            if (html.includes('tgme_widget_message')) {
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
