#!/usr/bin/env node
// scripts/seed-admin.js
// Creates (or resets) the super-admin account.
// Usage:  node scripts/seed-admin.js

import crypto from 'crypto';
import { promisify } from 'util';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf  = await scryptAsync(password, salt, 64);
  return `${salt}:${buf.toString('hex')}`;
}

const ADMIN_EMAIL    = 'admin@callora.me';
const ADMIN_PASSWORD = 'Admin1234x';
const TENANT_SLUG    = 'callora-admin';
const TENANT_NAME    = 'Callora Admin';

async function main() {
  // 1. Upsert tenant
  const tenant = await prisma.tenant.upsert({
    where:  { slug: TENANT_SLUG },
    update: { name: TENANT_NAME },
    create: { slug: TENANT_SLUG, name: TENANT_NAME },
  });
  console.log('Tenant:', tenant.id, tenant.slug);

  // 2. Hash password
  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  // 3. Upsert user
  const user = await prisma.user.upsert({
    where:  { email: ADMIN_EMAIL },
    update: {
      passwordHash,
      platformRole: 'SUPERADMIN',
      emailVerifiedAt: new Date(),
    },
    create: {
      tenantId:        tenant.id,
      email:           ADMIN_EMAIL,
      username:        'admin',
      fullName:        'Admin',
      passwordHash,
      platformRole:    'SUPERADMIN',
      role:            'OWNER',
      emailVerifiedAt: new Date(),
    },
  });
  console.log('Admin user:', user.id, user.email, '| platformRole:', user.platformRole);
  console.log('Done — you can now log in with', ADMIN_EMAIL);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
