import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from './generated/prisma/client';

export function createPrismaClient(): PrismaClient {
    const adapter = new PrismaBetterSqlite3({
        url: process.env.DATABASE_URL || 'file:./dev.db',
    });
    return new PrismaClient({ adapter });
}
