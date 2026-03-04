// ─────────────────────────────────────────────────────────────────────────────
// routes/appointment-routes.js
//
// Appointment endpoints:
//   GET  /api/tenants/:tenantId/appointments/today  — today's schedule + stats
//   POST /api/tenants/:tenantId/appointments        — create a new appointment
//   GET  /api/tenants/:tenantId/modal-data          — services + staff for the modal
//
// All routes require a valid JWT whose tenantId matches the URL param.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getTodaysAppointments,
  getDashboardStats,
  getServicesAndStaff,
} from '../services/appointment-service.js';
import { BookingEngine } from '../services/booking-engine.js';
import { logActivity } from '../services/activity-service.js';

export default async function appointmentRoutes(fastify) {

  // ── Auth + clinic guard ───────────────────────────────────────────────────
  async function requireAuth(request, reply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (request.user.tenantId !== request.params.tenantId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  }

  // ── GET /api/tenants/:tenantId/appointments/today ─────────────────────────
  fastify.get(
    '/api/tenants/:tenantId/appointments/today',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { tenantId } = request.params;
      const [schedule, stats] = await Promise.all([
        getTodaysAppointments(tenantId),
        getDashboardStats(tenantId),
      ]);
      return {
        date: new Date().toISOString().slice(0, 10),
        ...schedule,    // { stats, appointments }
        dashboardStats: stats,
      };
    },
  );

  // ── GET /api/tenants/:tenantId/modal-data ────────────────────────────────
  // Lightweight endpoint for populating the New Booking modal dropdowns.
  fastify.get(
    '/api/tenants/:tenantId/modal-data',
    { preHandler: [requireAuth] },
    async (request) => {
      return getServicesAndStaff(request.params.tenantId);
    },
  );

  // ── POST /api/tenants/:tenantId/appointments ──────────────────────────────
  fastify.post(
    '/api/tenants/:tenantId/appointments',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { tenantId } = request.params;

      let appointment;
      try {
        appointment = await BookingEngine.createAppointment(tenantId, request.body, 'manual');
      } catch (err) {
        const status = err.statusCode ?? (err.code === 404 ? 404 : (err.code || 400));
        return reply.code(status).send({
          error:  err.message,
          code:   err.code ?? null,
          errors: err.errors ?? undefined,
        });
      }

      // Fire-and-forget activity log
      logActivity(tenantId, {
        type:        'appointment_created',
        description: `<strong>${appointment.client.fullName}</strong> booked a ${appointment.service.name}`,
        entityType:  'appointment',
        entityId:    appointment.id,
      });

      return reply.code(201).send({
        id:         appointment.id,
        status:     'confirmed',
        startsAt:   appointment.startsAt,
        endsAt:     appointment.endsAt,
        client:     { name: appointment.client.fullName, phone: appointment.client.phone },
        staff:      { name: appointment.staff.name },
        service:    { name: appointment.service.name },
      });
    },
  );
}
