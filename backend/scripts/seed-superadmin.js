#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/seed-superadmin.js
//
// Elevates an existing user to SUPERADMIN platform role.
// Usage:
//   DATABASE_URL="postgresql://..." node scripts/seed-superadmin.js <email>
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const email  = process.argv[2];

if (!email) {
  console.error('Usage: node scripts/seed-superadmin.js <email>');
  process.exit(1);
}

const user = await prisma.user.findUnique({ where: { email } });
if (!user) {
  console.error(`No user found with email: ${email}`);
  process.exit(1);
}

await prisma.user.update({
  where: { email },
  data:  { platformRole: 'SUPERADMIN' },
});

console.log(`✓ ${email} is now SUPERADMIN`);
await prisma.$disconnect();
