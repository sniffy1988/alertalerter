const lastLiveByChannel = new Map<number, number>();

export function markMtprotoLive(channelId: number): void {
    lastLiveByChannel.set(channelId, Date.now());
}

export function mtprotoLastLiveAt(channelId: number): number | undefined {
    return lastLiveByChannel.get(channelId);
}

export function mtprotoRecentlyLive(channelId: number, withinMs?: number): boolean {
    const windowMs = withinMs ?? parseScrapeBackoffMs();
    const at = lastLiveByChannel.get(channelId);
    return at != null && Date.now() - at < windowMs;
}

export function parseScrapeBackoffMs(): number {
    const n = Number(process.env.SCRAPER_MTPROTO_BACKOFF_MS);
    if (Number.isFinite(n) && n >= 0) return Math.min(120_000, Math.floor(n));
    return 8_000;
}
