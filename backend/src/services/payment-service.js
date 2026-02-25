// ─────────────────────────────────────────────────────────────────────────────
// services/payment-service.js
// Business logic for payments / revenue.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

function fmtGBP(pence) {
  return `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/**
 * List payments for a tenant with optional filter.
 * filter: 'all' | 'paid' | 'pending' | 'refunded'
 */
export async function listPayments(tenantId, { filter = 'all', search = '', limit = 100 } = {}) {
  const where = { tenantId };

  if (filter === 'paid')     where.status = 'PAID';
  if (filter === 'pending')  where.status = 'PENDING';
  if (filter === 'refunded') where.status = { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] };

  const payments = await prisma.payment.findMany({
    where,
    include: {
      client:      { select: { fullName: true } },
      appointment: { include: { service: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return payments
    .filter(p => !search ||
      p.client.fullName.toLowerCase().includes(search.toLowerCase()) ||
      (p.appointment?.service?.name ?? '').toLowerCase().includes(search.toLowerCase())
    )
    .map(p => ({
      id:          p.id,
      date:        p.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
      client:      p.client.fullName,
      service:     p.appointment?.service?.name ?? 'N/A',
      amount:      fmtGBP(p.amountCents),
      amountRaw:   p.amountCents,
      type:        p.type === 'FULL_PAYMENT' ? 'Full' : p.type === 'DEPOSIT' ? 'Deposit' : 'Refund',
      status:      p.status.toLowerCase().replace('_', '-'),
      icon:        p.status === 'PAID' ? '💳' : p.status === 'PENDING' ? '🕐' : '↩️',
      bg:          p.status === 'PAID' ? '#f0fdf4' : p.status === 'PENDING' ? '#fffbeb' : '#fef2f2',
    }));
}

/**
 * Get stat-card totals for the payments page.
 */
export async function getPaymentStats(tenantId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [thisMonth, lastMonth, pending, refunds, countThisMonth] = await Promise.all([
    prisma.payment.aggregate({
      where: { tenantId, status: 'PAID', createdAt: { gte: monthStart } },
      _sum: { amountCents: true },
      _count: true,
    }),
    prisma.payment.aggregate({
      where: { tenantId, status: 'PAID', createdAt: { gte: lastMonthStart, lt: monthStart } },
      _sum: { amountCents: true },
    }),
    prisma.payment.findMany({
      where: { tenantId, status: 'PENDING' },
      select: { amountCents: true, id: true },
    }),
    prisma.payment.aggregate({
      where: { tenantId, status: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] }, createdAt: { gte: monthStart } },
      _sum: { amountCents: true },
      _count: true,
    }),
    prisma.payment.count({
      where: { tenantId, status: 'PAID', createdAt: { gte: monthStart } },
    }),
  ]);

  const revenueThisMonth = thisMonth._sum.amountCents ?? 0;
  const revenueLastMonth = lastMonth._sum.amountCents ?? 0;
  const changeVsLast = revenueLastMonth > 0 ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100) : 0;
  const totalPending = pending.reduce((s, p) => s + p.amountCents, 0);
  const avgTransaction = countThisMonth > 0 ? Math.round(revenueThisMonth / countThisMonth) : 0;

  return {
    revenueThisMonth: fmtGBP(revenueThisMonth),
    revenueChangeVsLast: changeVsLast,
    outstanding: fmtGBP(totalPending),
    outstandingCount: pending.length,
    avgTransaction: fmtGBP(avgTransaction),
    refundsThisMonth: fmtGBP(refunds._sum.amountCents ?? 0),
    refundCount: refunds._count,
  };
}

/**
 * Weekly revenue for the last 8 weeks (bar chart).
 */
export async function getWeeklyRevenue(tenantId, weeks = 8) {
  const now = new Date();
  // Go back 'weeks' full weeks from this Monday
  const todayDay = now.getDay(); // 0=Sun
  const daysToMon = todayDay === 0 ? 6 : todayDay - 1;
  const thisMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysToMon);

  const result = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date(thisMon.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const weekEnd   = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    const agg = await prisma.payment.aggregate({
      where: {
        tenantId,
        status: 'PAID',
        createdAt: { gte: weekStart, lt: weekEnd },
      },
      _sum: { amountCents: true },
    });

    const label = weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    result.push({
      label,
      value: Math.round((agg._sum.amountCents ?? 0) / 100),
      current: i === 0, // current (partial) week
    });
  }
  return result;
}

/**
 * Revenue breakdown by service for the current month.
 */
export async function getRevenueByService(tenantId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const payments = await prisma.payment.findMany({
    where: {
      tenantId,
      status: 'PAID',
      createdAt: { gte: monthStart },
    },
    include: {
      appointment: {
        include: { service: { select: { name: true } } },
      },
    },
  });

  // Group by service name
  const breakdown = {};
  for (const p of payments) {
    const name = p.appointment?.service?.name ?? 'Other';
    if (!breakdown[name]) breakdown[name] = { revenue: 0, txns: 0 };
    breakdown[name].revenue += p.amountCents;
    breakdown[name].txns += 1;
  }

  return Object.entries(breakdown)
    .map(([name, d]) => ({
      name,
      revenue: Math.round(d.revenue / 100),
      txns: d.txns,
      avg: d.txns ? Math.round(d.revenue / d.txns / 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * Mark a payment as PAID.
 */
export async function markPaymentPaid(tenantId, paymentId) {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, tenantId },
  });
  if (!payment) throw new Error('Payment not found');

  return prisma.payment.update({
    where: { id: paymentId },
    data:  { status: 'PAID' },
  });
}
