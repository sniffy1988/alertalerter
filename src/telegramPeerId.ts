import { utils } from 'telegram';
import type { Api } from 'telegram/tl';

/** Canonical MTProto peer id, e.g. `-1001234567890`. */
export function resolvePeerIdFromEntity(entity: Api.TypeEntityLike): string {
    return utils.getPeerId(entity).toString();
}

/** All chatId formats GramJS may emit for the same channel. */
export function peerIdAliases(peerId: string): string[] {
    const aliases = new Set<string>([peerId]);
    const fullMatch = peerId.match(/^-100(\d+)$/);
    if (fullMatch) {
        aliases.add(fullMatch[1]);
    } else if (/^\d+$/.test(peerId)) {
        aliases.add(`-100${peerId}`);
    }
    return [...aliases];
}
