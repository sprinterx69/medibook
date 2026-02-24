// ─────────────────────────────────────────────────────────────────────────────
// services/activity-service.js
//
// Audit-trail / activity-feed for the MediBook dashboard.
//   logActivity     — writes a new ActivityLog row (non-fatal on error)
//   getRecentActivity — returns the N most recent entries with relative timestamps
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Icon + colour map per activity type ──────────────────────────────────────
const TYPE_META = {
  appointment_created:   { icon: '📅', bgColor: '#f0fdfa' },
  appointment_completed: { icon: '✅', bgColor: '#f5f3ff' },
  appointment_cancelled: { icon: '❌', bgColor: '#fff1f2' },
  appointment_no_show:   { icon: '🚫', bgColor: '#fff1f2' },
  client_created:        { icon: '👤', bgColor: '#eff6ff' },
  payment_received:      { icon: '💳', bgColor: '#f0fdf4' },
  call_received:         { icon: '📞', bgColor: '#fff7ed' },
  booking_from_call:     { icon: '🤖', bgColor: '#fdf4ff' },
  staff_added:           { icon: '👥', bgColor: '#f0fdf4' },
  service_created:       { icon: '✨', bgColor: '#fefce8' },
};

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Log an activity entry. Silently ignores write errors so it never blocks
 * the main request.
 *
 * @param {string} tenantId
 * @param {{ type: string, description: string, entityType?: string, entityId?: string, metadata?: object }} opts
 */
export async function logActivity(tenantId, { type, description, entityType, entityId, metadata } = {}) {
  const meta = TYPE_META[type] ?? { icon: '📌', bgColor: '#f9f7f4' };
  try {
    await prisma.activityLog.create({
      data: {
        tenantId,
        type,
        description,
        icon:       meta.icon,
        bgColor:    meta.bgColor,
        entityType: entityType ?? null,
        entityId:   entityId   ?? null,
        metadata:   metadata   ?? undefined,
      },
    });
  } catch (err) {
    console.error('[activity] failed to log:', err.message);
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getRecentActivity(tenantId, limit = 20) {
  const rows = await prisma.activityLog.findMany({
    where:   { tenantId },
    orderBy: { createdAt: 'desc' },
    take:    Math.min(limit, 100),
  });

  return rows.map(r => ({
    id:          r.id,
    type:        r.type,
    description: r.description,
    icon:        r.icon,
    bgColor:     r.bgColor,
    entityType:  r.entityType,
    entityId:    r.entityId,
    createdAt:   r.createdAt,
    timeAgo:     relativeTime(r.createdAt),
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(date) {
  const diff = Date.now() - new Date(date).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)            return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)            return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24)            return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
