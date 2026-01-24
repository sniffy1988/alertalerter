import { PrismaClient } from '@prisma/client';

// In Prisma 6, with SQLite, we don't need manual adapters 
// for standard file-based operations. 
// It will automatically use its internal engine.

const prisma = new PrismaClient();

export default prisma;
