// ─────────────────────────────────────────────────────────────────────────────
// services/calendar-service.js
// Business logic for calendar / appointment views.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

/** ISO date string → start-of-day UTC */
function dayStart(iso) {
  const d = new Date(iso + 'T00:00:00.000Z');
  return d;
}

/** ISO date string → end-of-day UTC */
function dayEnd(iso) {
  const d = new Date(iso + 'T23:59:59.999Z');
  return d;
}

/**
 * Returns all appointments for a given week.
 * weekStart: 'YYYY-MM-DD' (Monday of the week)
 */
export async function getWeekAppointments(tenantId, weekStart) {
  const start = dayStart(weekStart);
  // End = 7 days later
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  const appts = await prisma.appointment.findMany({
    where: {
      tenantId,
      startsAt: { gte: start, lt: end },
      status: { not: 'CANCELLED' },
    },
    include: {
      client:  { select: { id: true, fullName: true, phone: true } },
      staff:   { select: { id: true, name: true, color: true } },
      service: { select: { id: true, name: true, durationMins: true, priceCents: true, color: true } },
    },
    orderBy: { startsAt: 'asc' },
  });

  return appts.map(a => ({
    id:          a.id,
    startsAt:    a.startsAt.toISOString(),
    endsAt:      a.endsAt.toISOString(),
    status:      a.status.toLowerCase().replace('_', '-'),
    notes:       a.notes ?? '',
    source:      a.source ?? 'dashboard',
    client: {
      id:       a.client.id,
      name:     a.client.fullName,
      phone:    a.client.phone ?? '',
    },
    staff: {
      id:    a.staff.id,
      name:  a.staff.name,
      color: a.staff.color,
    },
    service: {
      id:          a.service.id,
      name:        a.service.name,
      durationMins: a.service.durationMins,
      price:       `£${(a.service.priceCents / 100).toFixed(0)}`,
      color:       a.service.color,
    },
  }));
}

/**
 * Returns all appointments for a single day.
 * date: 'YYYY-MM-DD'
 */
export async function getDayAppointments(tenantId, date) {
  const start = dayStart(date);
  const end   = dayEnd(date);

  const appts = await prisma.appointment.findMany({
    where: {
      tenantId,
      startsAt: { gte: start, lte: end },
      status: { not: 'CANCELLED' },
    },
    include: {
      client:  { select: { id: true, fullName: true } },
      staff:   { select: { id: true, name: true, color: true } },
      service: { select: { id: true, name: true, durationMins: true, color: true } },
    },
    orderBy: { startsAt: 'asc' },
  });

  return appts.map(a => ({
    id:       a.id,
    startsAt: a.startsAt.toISOString(),
    endsAt:   a.endsAt.toISOString(),
    status:   a.status.toLowerCase(),
    client:   { id: a.client.id, name: a.client.fullName },
    staff:    { id: a.staff.id, name: a.staff.name, color: a.staff.color },
    service:  { id: a.service.id, name: a.service.name, durationMins: a.service.durationMins, color: a.service.color },
  }));
}

/**
 * Returns upcoming appointments for the week (for the bottom table).
 */
export async function getUpcomingWeek(tenantId, weekStart) {
  const start = dayStart(weekStart);
  const end   = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  const appts = await prisma.appointment.findMany({
    where: {
      tenantId,
      startsAt: { gte: start, lt: end },
    },
    include: {
      client:  { select: { fullName: true } },
      staff:   { select: { name: true } },
      service: { select: { name: true, durationMins: true } },
    },
    orderBy: { startsAt: 'asc' },
  });

  return appts.map(a => ({
    id:          a.id,
    startsAt:    a.startsAt.toISOString(),
    status:      a.status,
    clientName:  a.client.fullName,
    staffName:   a.staff.name,
    serviceName: a.service.name,
    durationMins: a.service.durationMins,
  }));
}
