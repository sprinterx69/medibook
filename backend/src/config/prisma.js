// ─────────────────────────────────────────────────────────────────────────────
// config/prisma.js
// Single PrismaClient instance shared across the entire app.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'info', 'warn', 'error'] 
    : ['error'],
});

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
