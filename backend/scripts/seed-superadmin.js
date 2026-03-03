#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/seed-superadmin.js
//
// One-time script to elevate an existing user to SUPERADMIN platform role.
// Run ONCE after deploying Phase 2 (role guards) to ensure at least one
// admin user exists before the admin routes go live.
//
// Usage:
//   DATABASE_URL="..." node scripts/seed-superadmin.js admin@callora.me
//
// Requirements:
//   - The user must already exist in the database (created via normal registration)
//   - DATABASE_URL must be set in the environment
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const email = process.argv[2];

if (!email) {
  console.error('Usage: node scripts/seed-superadmin.js <email>');
  process.exit(1);
}

async function main() {
  const user = await prisma.user.findUnique({
    where:  { email: email.toLowerCase().trim() },
    select: { id: true, email: true, fullName: true, platformRole: true },
  });

  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  if (user.platformRole === 'SUPERADMIN') {
    console.log(`✓ ${user.email} (${user.fullName}) is already a SUPERADMIN.`);
    process.exit(0);
  }

  await prisma.user.update({
    where: { id: user.id },
    data:  { platformRole: 'SUPERADMIN' },
  });

  console.log(`✓ ${user.email} (${user.fullName}) elevated to SUPERADMIN.`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
