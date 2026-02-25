// ─────────────────────────────────────────────────────────────────────────────
// services/client-service.js
// Business logic for client management.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

function initials(name) {
  return name.split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
}

const AV_COLORS = [
  { bg: '#f0fdfa', col: '#115e59' },
  { bg: '#eff6ff', col: '#1e40af' },
  { bg: '#f5f3ff', col: '#5b21b6' },
  { bg: '#fff7ed', col: '#9a3412' },
  { bg: '#fdf2f8', col: '#9d174d' },
  { bg: '#f0fdf4', col: '#166534' },
  { bg: '#fffbeb', col: '#92400e' },
  { bg: '#fef2f2', col: '#991b1b' },
];

function clientColor(id) {
  // Deterministic color from client id
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return AV_COLORS[Math.abs(hash) % AV_COLORS.length];
}

/**
 * List all clients for a tenant with optional search/filter.
 */
export async function listClients(tenantId, { search = '', filter = 'all', sort = 'name', order = 'asc', limit = 200 } = {}) {
  const where = { tenantId };

  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: 'insensitive' } },
      { email:    { contains: search, mode: 'insensitive' } },
      { phone:    { contains: search } },
    ];
  }

  if (filter === 'vip') {
    where.tags = { has: 'VIP' };
  }

  const clients = await prisma.client.findMany({
    where,
    include: {
      appointments: {
        where: { status: { not: 'CANCELLED' } },
        select: { id: true, startsAt: true, completedAt: true },
        orderBy: { startsAt: 'desc' },
      },
      payments: {
        where: { status: 'PAID' },
        select: { amountCents: true },
      },
    },
    orderBy: sort === 'name' ? { fullName: order } : { createdAt: 'desc' },
    take: limit,
  });

  // Compute derived fields
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  return clients
    .filter(c => {
      if (filter === 'active') {
        return c.appointments.some(a => new Date(a.startsAt) >= thirtyDaysAgo);
      }
      if (filter === 'inactive') {
        return !c.appointments.some(a => new Date(a.startsAt) >= thirtyDaysAgo);
      }
      return true;
    })
    .map(c => {
      const color = clientColor(c.id);
      const lifetimeSpend = c.payments.reduce((s, p) => s + p.amountCents, 0);
      const lastAppt = c.appointments[0];
      const isActive = c.appointments.some(a => new Date(a.startsAt) >= thirtyDaysAgo);

      return {
        id:           c.id,
        fullName:     c.fullName,
        email:        c.email ?? '',
        phone:        c.phone ?? '',
        initials:     initials(c.fullName),
        avatarBg:     color.bg,
        avatarColor:  color.col,
        since:        c.createdAt.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
        lastVisit:    lastAppt ? new Date(lastAppt.startsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Never',
        visits:       c.appointments.length,
        lifetimeSpend: `£${(lifetimeSpend / 100).toLocaleString()}`,
        lifetimeSpendPence: lifetimeSpend,
        tags:         c.tags,
        isVip:        c.tags.includes('VIP'),
        status:       isActive ? 'active' : 'inactive',
        noShowCount:  c.noShowCount,
        source:       c.source ?? 'unknown',
      };
    });
}

/**
 * Get client stats for the stats row.
 */
export async function getClientStats(tenantId) {
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const thirtyDaysAgo  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo   = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const [total, activeThisMonth, activeLastMonth, paidPayments] = await Promise.all([
    prisma.client.count({ where: { tenantId } }),
    prisma.client.count({
      where: {
        tenantId,
        appointments: { some: { startsAt: { gte: thirtyDaysAgo }, status: { not: 'CANCELLED' } } },
      },
    }),
    prisma.client.count({
      where: {
        tenantId,
        appointments: { some: { startsAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo }, status: { not: 'CANCELLED' } } },
      },
    }),
    prisma.payment.findMany({
      where: { tenantId, status: 'PAID' },
      select: { amountCents: true, clientId: true },
    }),
  ]);

  // Average lifetime spend
  const clientSpend = {};
  for (const p of paidPayments) {
    clientSpend[p.clientId] = (clientSpend[p.clientId] ?? 0) + p.amountCents;
  }
  const spends = Object.values(clientSpend);
  const avgSpend = spends.length ? spends.reduce((a, b) => a + b, 0) / spends.length : 0;

  return {
    total,
    activeThisMonth,
    activeThisMonthDelta: activeThisMonth - activeLastMonth,
    avgLifetimeSpend: `£${(avgSpend / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
  };
}

/**
 * Get a single client with full appointment history.
 */
export async function getClientById(tenantId, clientId) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, tenantId },
    include: {
      appointments: {
        where: { status: { not: 'CANCELLED' } },
        include: {
          service: { select: { name: true, priceCents: true } },
          staff:   { select: { name: true } },
          payments: { where: { status: 'PAID' }, select: { amountCents: true } },
        },
        orderBy: { startsAt: 'desc' },
        take: 20,
      },
      payments: {
        where: { status: 'PAID' },
        select: { amountCents: true },
      },
    },
  });

  if (!client) return null;

  const color = clientColor(client.id);
  const lifetimeSpend = client.payments.reduce((s, p) => s + p.amountCents, 0);

  return {
    id:           client.id,
    fullName:     client.fullName,
    email:        client.email ?? '',
    phone:        client.phone ?? '',
    initials:     initials(client.fullName),
    avatarBg:     color.bg,
    avatarColor:  color.col,
    since:        client.createdAt.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
    visits:       client.appointments.length,
    lifetimeSpend: `£${(lifetimeSpend / 100).toLocaleString()}`,
    tags:         client.tags,
    isVip:        client.tags.includes('VIP'),
    medicalNotes: client.medicalNotes ?? '',
    noShowCount:  client.noShowCount,
    history: client.appointments.map(a => ({
      id:          a.id,
      serviceName: a.service.name,
      staffName:   a.staff.name,
      date:        a.startsAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      amount:      `£${(a.service.priceCents / 100).toFixed(0)}`,
      status:      a.status,
    })),
  };
}

/**
 * Create a new client.
 */
export async function createClient(tenantId, { fullName, email, phone, notes }) {
  const data = { tenantId, fullName, source: 'dashboard' };
  if (email) data.email = email.toLowerCase().trim();
  if (phone) data.phone = phone.trim();
  if (notes) data.medicalNotes = notes;

  return prisma.client.create({ data });
}

/**
 * Update client notes/tags.
 */
export async function updateClient(tenantId, clientId, updates) {
  const allowed = {};
  if (updates.medicalNotes !== undefined) allowed.medicalNotes = updates.medicalNotes;
  if (updates.tags !== undefined)         allowed.tags = updates.tags;
  if (updates.fullName !== undefined)     allowed.fullName = updates.fullName;
  if (updates.phone !== undefined)        allowed.phone = updates.phone;

  return prisma.client.updateMany({
    where: { id: clientId, tenantId },
    data:  allowed,
  });
}
