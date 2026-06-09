import fs from 'fs';
import path from 'path';

export function loadSessionString(): string {
    const fromEnv = process.env.TELEGRAM_USER_SESSION?.trim();
    if (fromEnv) return fromEnv;

    const sessionPath = process.env.TELEGRAM_SESSION_PATH?.trim();
    if (sessionPath && fs.existsSync(sessionPath)) {
        return fs.readFileSync(sessionPath, 'utf8').trim();
    }

    return '';
}

export function hasMtprotoCredentials(): boolean {
    const apiId = process.env.TELEGRAM_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH;
    const session = loadSessionString();
    return !!(apiId && apiHash && session);
}

export function getIngestMode(): 'mtproto' | 'scrape' {
    const mode = (process.env.INGEST_MODE || 'auto').toLowerCase();
    if (mode === 'scrape') return 'scrape';
    if (mode === 'mtproto') return 'mtproto';
    return hasMtprotoCredentials() ? 'mtproto' : 'scrape';
}

export function getApiCredentials(): { apiId: number; apiHash: string } {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    if (!apiId || !apiHash) {
        throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required for MTProto ingest');
    }
    return { apiId, apiHash };
}

export function persistSession(clientSession: string): boolean {
    const sessionPath = process.env.TELEGRAM_SESSION_PATH?.trim();
    if (!sessionPath) return false;

    try {
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
        fs.writeFileSync(sessionPath, clientSession, 'utf8');
        return true;
    } catch {
        return false;
    }
}
