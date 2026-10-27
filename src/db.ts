import { createPrismaClient } from './prismaFactory';

const prisma = createPrismaClient();

export async function enableSqliteWal(): Promise<void> {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=2000');
}

export default prisma;
