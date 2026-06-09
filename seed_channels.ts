import { PrismaClient } from '@prisma/client';
import { syncSeedChannels, syncSeedFilterPhrases } from './src/seedLib';

const prisma = new PrismaClient();

async function main() {
    await syncSeedChannels(prisma);
    await syncSeedFilterPhrases(prisma);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
