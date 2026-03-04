// ─────────────────────────────────────────────────────────────────────────────
// services/booking-engine.js
//
// BookingEngine — validation wrapper around appointment-service.createAppointment.
// Controlled by env BOOKING_ENGINE_ENABLED=true (default off).
//
// Validation pipeline (7 checks):
//   1. Blackout date
//   2. Operating hours
//   3. Consultation days
//   4. Time blocks
//   5. Max daily bookings
//   6. Double-booking
//   7. Buffer time between appointments
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';
import { createAppointment } from './appointment-service.js';

const ENGINE_ENABLED = () => process.env.BOOKING_ENGINE_ENABLED === 'true';

// ─── Validation ───────────────────────────────────────────────────────────────

async function validateBooking(tenantId, body) {
  const errors = [];

  const startsAt = new Date(body.startsAt);
  if (isNaN(startsAt.getTime())) {
    return [{ code: 'INVALID_DATE', message: 'Invalid startsAt date.' }];
  }

  const dayOfWeek = startsAt.getDay(); // 0=Sun … 6=Sat
  const timeStr   = startsAt.toTimeString().slice(0, 5); // "HH:MM"

  // 1. Blackout date
  const dateOnly = new Date(startsAt);
  dateOnly.setHours(0, 0, 0, 0);
  const blackout = await prisma.blackoutDate.findFirst({
    where: { tenantId, date: dateOnly },
  });
  if (blackout) {
    errors.push({ code: 'BLACKOUT_DATE', message: `${blackout.label || 'Closed'} on this date.` });
  }

  // 2–4. Consultation rules
  const rule = await prisma.consultationRule.findUnique({ where: { tenantId } });
  if (rule) {
    // 2. Available days
    const availableDays = Array.isArray(rule.availableDays) ? rule.availableDays : JSON.parse(rule.availableDays);
    if (!availableDays.includes(dayOfWeek)) {
      errors.push({ code: 'UNAVAILABLE_DAY', message: 'No appointments available on this day.' });
    }

    // 3–4. Time blocks
    const timeBlocks = Array.isArray(rule.timeBlocks) ? rule.timeBlocks : JSON.parse(rule.timeBlocks);
    const inBlock = timeBlocks.some(block => timeStr >= block.start && timeStr < block.end);
    if (!inBlock) {
      errors.push({ code: 'OUTSIDE_HOURS', message: 'Time is outside operating hours.' });
    }

    // 5. Max daily bookings
    const dayStart = new Date(startsAt); dayStart.setHours(0, 0, 0, 0);
    const dayEnd   = new Date(startsAt); dayEnd.setHours(23, 59, 59, 999);
    const todayCount = await prisma.appointment.count({
      where: { tenantId, startsAt: { gte: dayStart, lte: dayEnd }, status: { not: 'CANCELLED' } },
    });
    if (todayCount >= rule.maxPerDay) {
      errors.push({ code: 'MAX_DAILY_REACHED', message: 'Maximum daily appointments reached.' });
    }

    // 7. Buffer time
    if (rule.bufferMins > 0) {
      const bufferBefore = new Date(startsAt.getTime() - rule.bufferMins * 60 * 1000);
      const bufferAfter  = new Date(startsAt.getTime() + rule.bufferMins * 60 * 1000);
      const tooClose = await prisma.appointment.findFirst({
        where: {
          tenantId,
          status: { not: 'CANCELLED' },
          startsAt: { gte: bufferBefore, lte: bufferAfter },
        },
      });
      if (tooClose) {
        errors.push({ code: 'BUFFER_CONFLICT', message: `Must be at least ${rule.bufferMins} minutes from another appointment.` });
      }
    }
  }

  // 6. Double-booking (always checked regardless of rule)
  if (body.staffId) {
    const dbl = await prisma.appointment.findFirst({
      where: {
        tenantId,
        staffId: body.staffId,
        startsAt,
        status: { not: 'CANCELLED' },
      },
    });
    if (dbl) {
      errors.push({ code: 'DOUBLE_BOOKING', message: 'This slot is already booked.' });
    }
  }

  return errors;
}

// ─── Log ──────────────────────────────────────────────────────────────────────

async function logBookingAttempt({ tenantId, appointmentId, source, outcome, validationErrors = [] }) {
  try {
    await prisma.bookingEngineLog.create({
      data: { tenantId, appointmentId, source, outcome, validationErrors },
    });
  } catch {
    // Non-fatal
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const BookingEngine = {
  async createAppointment(tenantId, body, source = 'manual') {
    if (!ENGINE_ENABLED()) {
      // Feature flag off — bypass validation entirely
      return createAppointment(tenantId, body);
    }

    const errors = await validateBooking(tenantId, body);
    if (errors.length > 0) {
      await logBookingAttempt({ tenantId, source, outcome: 'rejected', validationErrors: errors });
      const err = new Error(errors[0].message);
      err.code = errors[0].code;
      err.statusCode = 422;
      err.errors = errors;
      throw err;
    }

    const appointment = await createAppointment(tenantId, { ...body, source });
    await logBookingAttempt({ tenantId, appointmentId: appointment.id, source, outcome: 'allowed' });
    return appointment;
  },
};
