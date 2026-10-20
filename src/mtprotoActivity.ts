const lastLiveByChannel = new Map<number, number>();

export function markMtprotoLive(channelId: number): void {
    lastLiveByChannel.set(channelId, Date.now());
}

export function mtprotoLastLiveAt(channelId: number): number | undefined {
    return lastLiveByChannel.get(channelId);
}
