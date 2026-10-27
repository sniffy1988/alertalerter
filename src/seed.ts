import { createPrismaClient } from './prismaFactory';
import { syncSeedChannels, syncSeedFilterPhrases } from './seedLib';

const prisma = createPrismaClient();

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
