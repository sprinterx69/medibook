// ─────────────────────────────────────────────────────────────────────────────
// services/appointment-service.js
//
// Business logic for appointments:
//   getTodaysAppointments  — fetches today's schedule + stats for a tenant
//   getAppointmentStats    — broader dashboard stats (revenue, new clients, AI calls)
//   createAppointment      — book a new appointment, find-or-create client
//   getServicesAndStaff    — data for the New Booking modal dropdowns
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function toHHMM(date) {
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',   // stored as UTC; front-end can adjust if needed
  });
}

/** Map Prisma enum → display string used by the front-end */
function normaliseStatus(s) {
  return s.toLowerCase().replace('_', '-'); // NO_SHOW → no-show
}

// ─── Today's Appointments ─────────────────────────────────────────────────────

export async function getTodaysAppointments(tenantId) {
  const { start, end } = todayRange();

  const rows = await prisma.appointment.findMany({
    where: { tenantId, startsAt: { gte: start, lte: end } },
    include: {
      client:  { select: { id: true, fullName: true, phone: true, email: true } },
      staff:   { select: { id: true, name: true, color: true, avatarUrl: true, role: true } },
      service: { select: { id: true, name: true, durationMins: true, priceCents: true, color: true } },
    },
    orderBy: { startsAt: 'asc' },
  });

  const stats = {
    total:     rows.length,
    confirmed: rows.filter(a => a.status === 'CONFIRMED').length,
    completed: rows.filter(a => a.status === 'COMPLETED').length,
    cancelled: rows.filter(a => a.status === 'CANCELLED').length,
    noShow:    rows.filter(a => a.status === 'NO_SHOW').length,
    pending:   rows.filter(a => a.status === 'PENDING').length,
  };

  const appointments = rows.map(a => ({
    id:         a.id,
    time:       toHHMM(a.startsAt),
    endsTime:   toHHMM(a.endsAt),
    startsAt:   a.startsAt,
    endsAt:     a.endsAt,
    status:     normaliseStatus(a.status),
    notes:      a.notes,
    source:     a.source,
    client: {
      id:    a.client.id,
      name:  a.client.fullName,
      phone: a.client.phone,
      email: a.client.email,
    },
    staff: {
      id:        a.staff.id,
      name:      a.staff.name,
      color:     a.staff.color,
      avatarUrl: a.staff.avatarUrl,
    },
    service: {
      id:          a.service.id,
      name:        a.service.name,
      durationMins: a.service.durationMins,
      priceCents:  a.service.priceCents,
      color:       a.service.color,
    },
  }));

  return { stats, appointments };
}

// ─── Dashboard Stats (revenue, new clients, AI calls) ────────────────────────

export async function getDashboardStats(tenantId) {
  const { start: todayStart, end: todayEnd } = todayRange();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [completedToday, newClientsMonth, aiCallsToday, revenueRows] = await Promise.all([
    // Count of all today's appointments (for the stat card)
    prisma.appointment.count({
      where: { tenantId, startsAt: { gte: todayStart, lte: todayEnd } },
    }),

    // New clients this month
    prisma.client.count({
      where: { tenantId, createdAt: { gte: monthStart } },
    }),

    // AI calls today
    prisma.callLog.count({
      where: { tenantId, createdAt: { gte: todayStart, lte: todayEnd } },
    }),

    // Completed appointment revenue today
    prisma.appointment.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
        startsAt: { gte: todayStart, lte: todayEnd },
      },
      include: { service: { select: { priceCents: true } } },
    }),
  ]);

  const todayRevenueCents = revenueRows.reduce((sum, a) => sum + (a.service?.priceCents ?? 0), 0);

  return {
    appointmentsToday: completedToday,
    newClientsMonth,
    aiCallsToday,
    todayRevenueCents: todayRevenueCents,
    todayRevenueFormatted: `$${(todayRevenueCents / 100).toFixed(0)}`,
  };
}

// ─── Create Appointment ───────────────────────────────────────────────────────

export async function createAppointment(tenantId, body) {
  const { clientName, clientPhone, clientEmail, serviceId, staffId, date, time, notes } = body;

  if (!clientName) throw Object.assign(new Error('clientName is required'), { code: 400 });
  if (!serviceId)  throw Object.assign(new Error('serviceId is required'),  { code: 400 });
  if (!staffId)    throw Object.assign(new Error('staffId is required'),    { code: 400 });
  if (!date)       throw Object.assign(new Error('date is required'),       { code: 400 });
  if (!time)       throw Object.assign(new Error('time is required'),       { code: 400 });

  // Validate service + staff belong to this tenant
  const [service, staff] = await Promise.all([
    prisma.service.findFirst({ where: { id: serviceId, tenantId, isActive: true } }),
    prisma.staff.findFirst({   where: { id: staffId,   tenantId, isActive: true } }),
  ]);
  if (!service) throw Object.assign(new Error('Service not found'), { code: 404 });
  if (!staff)   throw Object.assign(new Error('Staff not found'),   { code: 404 });

  // Find or create client (match on email first, then phone, then create new)
  let client = null;
  if (clientEmail) {
    client = await prisma.client.findFirst({ where: { tenantId, email: clientEmail } });
  }
  if (!client && clientPhone) {
    client = await prisma.client.findFirst({ where: { tenantId, phone: clientPhone } });
  }
  if (!client) {
    client = await prisma.client.create({
      data: {
        tenantId,
        fullName: clientName.trim(),
        phone:    clientPhone?.trim() || null,
        email:    clientEmail?.trim() || null,
        source:   'dashboard',
      },
    });
  }

  // Parse date + time into UTC Date objects
  // date = "YYYY-MM-DD", time = "HH:MM"
  const [y, m, d] = date.split('-').map(Number);
  const [h, min]  = time.split(':').map(Number);
  const startsAt  = new Date(Date.UTC(y, m - 1, d, h, min, 0));
  const endsAt    = new Date(startsAt.getTime() + service.durationMins * 60_000);

  const appointment = await prisma.appointment.create({
    data: {
      tenantId,
      clientId:  client.id,
      staffId,
      serviceId,
      startsAt,
      endsAt,
      status:    'CONFIRMED',
      source:    'dashboard',
      notes:     notes?.trim() || null,
    },
    include: {
      client:  { select: { id: true, fullName: true, phone: true } },
      staff:   { select: { id: true, name: true, color: true } },
      service: { select: { id: true, name: true, durationMins: true, priceCents: true } },
    },
  });

  return appointment;
}

// ─── Modal Dropdowns ──────────────────────────────────────────────────────────

export async function getServicesAndStaff(tenantId) {
  const [services, staff] = await Promise.all([
    prisma.service.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, name: true, durationMins: true, priceCents: true, color: true },
      orderBy: { name: 'asc' },
    }),
    prisma.staff.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, name: true, role: true, color: true, avatarUrl: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return { services, staff };
}
