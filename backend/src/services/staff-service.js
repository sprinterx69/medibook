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
