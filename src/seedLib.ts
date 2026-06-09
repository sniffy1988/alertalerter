import { PrismaClient } from '@prisma/client';

export const SEED_CHANNELS = [
    { link: 'tlknewsua', name: 'TLK', scrapTimeout: 1000 },
    { link: 'monitor1654', name: 'Монитор 1654', scrapTimeout: 1000 },
    { link: 'cxidua', name: 'CXID UA', scrapTimeout: 3000 }
];

export const SEED_FILTER_PHRASES = [
    { phrase: 'веселое', exclude: false },
    { phrase: 'веселе', exclude: false },
    { phrase: 'город', exclude: false },
    { phrase: 'місто', exclude: false },
    { phrase: 'чисто', exclude: false },
    { phrase: 'укрыт', exclude: false },
    { phrase: 'укрит', exclude: false },
    { phrase: 'ракета', exclude: false },
    { phrase: 'север', exclude: false },
    { phrase: 'північ', exclude: false },
    { phrase: 'доразведка', exclude: false },
    { phrase: 'дорозвідка', exclude: false },
    { phrase: 'повторные', exclude: false },
    { phrase: 'повторні', exclude: false },
    { phrase: 'алексеев', exclude: false },
    { phrase: 'олексіїв', exclude: false },
    { phrase: 'центр', exclude: false },
    { phrase: 'упал', exclude: false },
    { phrase: 'упав', exclude: false },
    { phrase: 'липц', exclude: false },
    { phrase: 'дергач', exclude: false },
    { phrase: 'угроз', exclude: false },
    { phrase: 'загроз', exclude: false },
    { phrase: 'быстр', exclude: false },
    { phrase: 'швидк', exclude: false },
    { phrase: 'наша боевая', exclude: false },
    { phrase: 'наша бойова', exclude: false },
    { phrase: '31к', exclude: false },
    { phrase: 'оставайтесь', exclude: false },
    { phrase: 'залишайтеся', exclude: false },
    { phrase: 'воздух', exclude: false },
    { phrase: 'повітря', exclude: false },
    { phrase: 'ещё', exclude: false },
    { phrase: 'ще', exclude: false },
    { phrase: '-59', exclude: false },
    { phrase: 'сад', exclude: false },
    { phrase: 'данило', exclude: false },
    { phrase: 'козач', exclude: false },
    { phrase: 'казач', exclude: false },
    { phrase: 'жуки', exclude: false },
    { phrase: 'сокол', exclude: false },
    { phrase: 'сокіл', exclude: false },
    { phrase: 'молния', exclude: false },
    { phrase: 'молні', exclude: false },
    { phrase: 'блискавка', exclude: false },
    { phrase: '-31', exclude: false },
    { phrase: 'пятихат', exclude: false },
    { phrase: 'пʼятихат', exclude: false },
    { phrase: 'харьков', exclude: false },
    { phrase: 'харків', exclude: false },
    { phrase: 'рсзо', exclude: true },
    { phrase: 'рсзв', exclude: true },
    { phrase: 'волчан', exclude: true },
    { phrase: 'вовчан', exclude: true },
    { phrase: 'новини', exclude: true },
    { phrase: 'новост', exclude: true },
    { phrase: 'tlkhelp', exclude: true },
    { phrase: 'Полтава', exclude: true },
    { phrase: 'полтав', exclude: true },
    { phrase: 'отчет', exclude: true },
    { phrase: 'звіт', exclude: true },
    { phrase: 'купян', exclude: true },
    { phrase: 'купʼян', exclude: true },
    { phrase: 'боров', exclude: true },
    { phrase: 'сумск', exclude: true },
    { phrase: 'сумськ', exclude: true },
    { phrase: 'донецк', exclude: true },
    { phrase: 'донецьк', exclude: true }
];

export function normalizeChannelLink(link: string): string {
    return link.split('/').pop()?.replace('@', '').toLowerCase() || link.toLowerCase();
}

export async function syncSeedChannels(prisma: PrismaClient): Promise<void> {
    const allowedLinks = new Set(SEED_CHANNELS.map(c => c.link));

    const existing = await prisma.channel.findMany({
        orderBy: { id: 'asc' }
    });

    const byNormalizedLink = new Map<string, typeof existing>();
    for (const channel of existing) {
        const normalized = normalizeChannelLink(channel.link);
        const group = byNormalizedLink.get(normalized) ?? [];
        group.push(channel);
        byNormalizedLink.set(normalized, group);
    }

    for (const [normalized, group] of byNormalizedLink) {
        if (group.length <= 1) {
            const channel = group[0];
            if (channel.link !== normalized) {
                await prisma.channel.update({
                    where: { id: channel.id },
                    data: { link: normalized }
                });
                console.log(`Normalized channel link: ${channel.link} -> ${normalized}`);
            }
            continue;
        }

        const keeper =
            group.find(ch => normalizeChannelLink(ch.link) === ch.link) ?? group[0];
        const duplicates = group.filter(ch => ch.id !== keeper.id);

        for (const duplicate of duplicates) {
            await prisma.message.deleteMany({ where: { channelId: duplicate.id } });
            await prisma.channel.update({
                where: { id: duplicate.id },
                data: { subscribers: { set: [] } }
            });
            await prisma.channel.delete({ where: { id: duplicate.id } });
            console.log(`Removed duplicate channel ${duplicate.link}, kept ${keeper.link}`);
        }

        if (keeper.link !== normalized) {
            await prisma.channel.update({
                where: { id: keeper.id },
                data: { link: normalized }
            });
        }
    }

    const channelsAfterMerge = await prisma.channel.findMany();
    for (const channel of channelsAfterMerge) {
        const normalized = normalizeChannelLink(channel.link);
        if (allowedLinks.has(normalized)) continue;

        await prisma.message.deleteMany({ where: { channelId: channel.id } });
        await prisma.channel.update({
            where: { id: channel.id },
            data: { subscribers: { set: [] } }
        });
        await prisma.channel.delete({ where: { id: channel.id } });
        console.log(`Removed channel not in seed: ${channel.link}`);
    }

    for (const channel of SEED_CHANNELS) {
        await prisma.channel.upsert({
            where: { link: channel.link },
            update: {
                name: channel.name,
                scrapTimeout: channel.scrapTimeout
            },
            create: channel
        });
        console.log(`Upserted Channel: ${channel.name}`);
    }
}

export async function syncSeedFilterPhrases(prisma: PrismaClient): Promise<void> {
    for (const rule of SEED_FILTER_PHRASES) {
        await prisma.filterPhrase.upsert({
            where: { phrase: rule.phrase },
            update: { exclude: rule.exclude },
            create: rule
        });
    }
    console.log('Seeded Filter Dictionary to DB');
}
