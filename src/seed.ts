import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const dictionary = [
    // --- POSITIVE HITS (Should send) ---
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
    { phrase: 'молні', exclude: false }, // Added based on your ID 69 observation
    { phrase: 'блискавка', exclude: false },
    { phrase: '-31', exclude: false },
    { phrase: 'пятихат', exclude: false },
    { phrase: 'пʼятихат', exclude: false },
    { phrase: 'харьков', exclude: false },
    { phrase: 'харків', exclude: false },

    // --- EXCLUSIONS (Filter out) ---
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
    { phrase: 'донецьк', exclude: true },
];

async function main() {
    // 1. Seed Channels
    const channels = [
        { link: 'tlknewsua', name: 'TLK', timeout: 2500 },
        { link: 'monitor1654', name: 'Монитор 1654', timeout: 2500 }
    ];

    for (const c of channels) {
        await prisma.channel.upsert({
            where: { link: c.link },
            update: { name: c.name, scrapTimeout: c.timeout },
            create: { link: c.link, name: c.name, scrapTimeout: c.timeout }
        });
        console.log(`Upserted Channel: ${c.name}`);
    }

    // 2. Seed Filter Rules
    for (const rule of dictionary) {
        await prisma.filterPhrase.upsert({
            where: { phrase: rule.phrase },
            update: { exclude: rule.exclude },
            create: { phrase: rule.phrase, exclude: rule.exclude }
        });
    }
    console.log('Seeded Filter Dictionary to DB');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
