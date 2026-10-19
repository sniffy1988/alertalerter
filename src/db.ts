import { PrismaClient } from '@prisma/client';

// In Prisma 6, with SQLite, we don't need manual adapters 
// for standard file-based operations. 
// It will automatically use its internal engine.

const prisma = new PrismaClient();

export async function enableSqliteWal(): Promise<void> {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=2000');
}

export default prisma;
