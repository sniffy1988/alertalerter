import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';

const rawUrl = process.env.DATABASE_URL || 'file:./dev.db';
const dbPath = rawUrl.startsWith('file:') ? rawUrl.replace('file:', '') : rawUrl;

// Use the constructor that the library actually expects in its factory
const adapter = new PrismaBetterSqlite3({ url: dbPath });

const prisma = new PrismaClient({ adapter });

export default prisma;
