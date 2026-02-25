// ─────────────────────────────────────────────────────────────────────────────
// services/service-catalog-service.js
// Business logic for the clinic's service catalogue (treatments).
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

/**
 * List all services for a tenant.
 */
export async function listServices(tenantId, { activeOnly = false } = {}) {
  const where = { tenantId };
  if (activeOnly) where.isActive = true;

  const services = await prisma.service.findMany({
    where,
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });

  return services.map(s => ({
    id:           s.id,
    name:         s.name,
    description:  s.description ?? '',
    durationMins: s.durationMins,
    price:        `£${(s.priceCents / 100).toFixed(0)}`,
    priceCents:   s.priceCents,
    depositCents: s.depositCents,
    category:     s.category ?? '',
    color:        s.color,
    isActive:     s.isActive,
  }));
}

/**
 * Create a new service.
 */
export async function createService(tenantId, { name, description, durationMins, priceCents, depositCents = 0, category, color }) {
  if (!name || !durationMins || !priceCents) {
    throw new Error('name, durationMins, and priceCents are required');
  }
  return prisma.service.create({
    data: {
      tenantId,
      name,
      description:  description ?? null,
      durationMins: parseInt(durationMins),
      priceCents:   parseInt(priceCents),
      depositCents: parseInt(depositCents ?? 0),
      category:     category ?? null,
      color:        color ?? '#0d9488',
    },
  });
}

/**
 * Update an existing service.
 */
export async function updateService(tenantId, serviceId, updates) {
  const service = await prisma.service.findFirst({ where: { id: serviceId, tenantId } });
  if (!service) throw new Error('Service not found');

  const allowed = {};
  if (updates.name !== undefined)         allowed.name = updates.name;
  if (updates.description !== undefined)  allowed.description = updates.description;
  if (updates.durationMins !== undefined) allowed.durationMins = parseInt(updates.durationMins);
  if (updates.priceCents !== undefined)   allowed.priceCents = parseInt(updates.priceCents);
  if (updates.depositCents !== undefined) allowed.depositCents = parseInt(updates.depositCents);
  if (updates.category !== undefined)     allowed.category = updates.category;
  if (updates.color !== undefined)        allowed.color = updates.color;
  if (updates.isActive !== undefined)     allowed.isActive = Boolean(updates.isActive);

  return prisma.service.update({ where: { id: serviceId }, data: allowed });
}

/**
 * Toggle service active/inactive.
 */
export async function toggleService(tenantId, serviceId) {
  const service = await prisma.service.findFirst({ where: { id: serviceId, tenantId } });
  if (!service) throw new Error('Service not found');
  return prisma.service.update({
    where: { id: serviceId },
    data:  { isActive: !service.isActive },
  });
}
