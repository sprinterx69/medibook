// ─────────────────────────────────────────────────────────────────────────────
// services/staff-service.js
//
// Staff queries for the dashboard and staff management screens.
//   getStaffOnDuty  — returns active staff with today's appointment counts
//                     and whether each is currently with a patient
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

export async function getStaffOnDuty(tenantId) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const staffRows = await prisma.staff.findMany({
    where:   { tenantId, isActive: true },
    include: {
      appointments: {
        where: { startsAt: { gte: todayStart, lte: todayEnd } },
        select: {
          id: true, startsAt: true, endsAt: true, status: true,
          client: { select: { fullName: true } },
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  const now = new Date();

  return staffRows.map(s => {
    const todayAppts = s.appointments.filter(a => a.status !== 'CANCELLED' && a.status !== 'NO_SHOW');
    const currentAppt = s.appointments.find(
      a => a.startsAt <= now && a.endsAt >= now && a.status === 'CONFIRMED',
    );

    return {
      id:                s.id,
      name:              s.name,
      title:             s.title,
      email:             s.email,
      role:              s.role,
      color:             s.color,
      avatarUrl:         s.avatarUrl,
      isAvailable:       s.isAvailable && !currentAppt,
      appointmentsToday: todayAppts.length,
      currentlyWith:     currentAppt ? currentAppt.client.fullName : null,
    };
  });
}

export async function getAllStaff(tenantId) {
  return prisma.staff.findMany({
    where:   { tenantId, isActive: true },
    select: {
      id: true, name: true, title: true, email: true, role: true,
      color: true, avatarUrl: true, isAvailable: true, isActive: true,
      createdAt: true,
    },
    orderBy: { name: 'asc' },
  });
}

export async function createStaff(tenantId, { name, email, title, color }) {
  if (!name?.trim()) throw new Error('name is required');
  const safeName  = name.trim();
  const safeEmail = email?.trim()
    || `${safeName.toLowerCase().replace(/[^a-z0-9]/g, '.')}@noemail.local`;

  return prisma.staff.create({
    data: {
      tenantId,
      name:     safeName,
      email:    safeEmail,
      title:    title ?? null,
      role:     'STAFF',
      color:    color ?? '#60a5fa',
      isActive: true,
    },
  });
}

export async function updateStaff(tenantId, staffId, updates) {
  const staff = await prisma.staff.findFirst({ where: { id: staffId, tenantId } });
  if (!staff) throw new Error('Staff member not found');

  const patch = {};
  if (updates.name  !== undefined) patch.name  = updates.name.trim();
  if (updates.email !== undefined) patch.email = updates.email.trim();
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.color !== undefined) patch.color = updates.color;
  if (updates.isAvailable !== undefined) patch.isAvailable = Boolean(updates.isAvailable);

  return prisma.staff.update({ where: { id: staffId }, data: patch });
}

export async function deleteStaff(tenantId, staffId) {
  const staff = await prisma.staff.findFirst({ where: { id: staffId, tenantId } });
  if (!staff) throw new Error('Staff member not found');
  await prisma.staff.update({ where: { id: staffId }, data: { isActive: false } });
  return { deleted: true };
}
