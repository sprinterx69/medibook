// ─────────────────────────────────────────────────────────────────────────────
// services/team-service.js
// Business logic for team member management (users within a tenant).
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();

function initials(name) {
  return name.split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
}

const ROLE_COLORS = {
  OWNER:  { bg: '#f0fdfa', col: '#115e59' },
  ADMIN:  { bg: '#eff6ff', col: '#1e40af' },
  MEMBER: { bg: '#f5f3ff', col: '#5b21b6' },
};

/**
 * List all team members (users) for a tenant.
 */
export async function listTeamMembers(tenantId) {
  const users = await prisma.user.findMany({
    where: { tenantId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });

  return users.map(u => {
    const color = ROLE_COLORS[u.role] ?? ROLE_COLORS.MEMBER;
    return {
      id:             u.id,
      fullName:       u.fullName,
      email:          u.email,
      role:           u.role,
      roleLabel:      u.role.charAt(0) + u.role.slice(1).toLowerCase(),
      title:          u.title ?? '',
      phone:          u.phone ?? '',
      avatarUrl:      u.avatarUrl ?? '',
      initials:       initials(u.fullName),
      avatarBg:       color.bg,
      avatarColor:    color.col,
      emailVerified:  Boolean(u.emailVerifiedAt),
      createdAt:      u.createdAt.toISOString(),
      isAvailable:    u.isAvailable,
    };
  });
}

/**
 * Invite a new team member (creates user with temporary password).
 * In production, send an email with a password-reset link.
 */
export async function inviteTeamMember(tenantId, { fullName, email, role = 'MEMBER', title = '' }) {
  if (!fullName || !email) throw new Error('fullName and email are required');

  // Check uniqueness
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) throw new Error('A user with this email already exists');

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('Tenant not found');

  // Generate a random username from name + tenant slug
  const base = fullName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const rand = Math.floor(Math.random() * 900 + 100);
  const username = `${base}${rand}`;

  // Temporary random password (user must reset via email in production)
  const tempPassword = Math.random().toString(36).slice(2, 10) + 'X1!';
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const user = await prisma.user.create({
    data: {
      tenantId,
      email:        email.toLowerCase().trim(),
      username,
      passwordHash,
      fullName,
      title:        title || null,
      role:         ['OWNER', 'ADMIN', 'MEMBER'].includes(role) ? role : 'MEMBER',
    },
  });

  return {
    id:       user.id,
    fullName: user.fullName,
    email:    user.email,
    role:     user.role,
    // In production: send invite email with password-reset link
    // For now return temp password so it can be shown to the admin
    tempPassword,
  };
}

/**
 * Update a team member's role.
 */
export async function updateTeamMemberRole(tenantId, userId, { role }) {
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!user) throw new Error('User not found');
  if (user.role === 'OWNER') throw new Error('Cannot change role of the account owner');

  const validRoles = ['ADMIN', 'MEMBER'];
  if (!validRoles.includes(role)) throw new Error('Invalid role');

  return prisma.user.update({ where: { id: userId }, data: { role } });
}

/**
 * Remove a team member from the tenant.
 */
export async function removeTeamMember(tenantId, userId) {
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!user) throw new Error('User not found');
  if (user.role === 'OWNER') throw new Error('Cannot remove the account owner');

  await prisma.user.delete({ where: { id: userId } });
  return { success: true };
}
