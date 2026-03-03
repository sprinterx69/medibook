// ─────────────────────────────────────────────────────────────────────────────
// services/booking-engine.js
//
// BookingEngine — Structured validation layer for ALL appointment creation.
// Wraps appointment-service.js. Both AI and manual bookings must go through here.
//
// Enabled via env flag: BOOKING_ENGINE_ENABLED=true
// If disabled (default), falls through to appointment-service directly.
//
// Every booking attempt is recorded in BookingEngineLog (allowed or rejected).
//
// Usage:
//   import { BookingEngine } from './booking-engine.js';
//   const appointment = await BookingEngine.createAppointment(tenantId, body, 'manual');
//   const appointment = await BookingEngine.createAppointment(tenantId, body, 'ai');
//
// On validation failure: throws { code, message, statusCode: 422 }
// On success: returns the created appointment record
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';
import { createAppointment } from './appointment-service.js';

const ENGINE_ENABLED = process.env.BOOKING_ENGINE_ENABLED === 'true';

// ─── BookingEngine ────────────────────────────────────────────────────────────

export const BookingEngine = {

  async createAppointment(tenantId, body, source = 'manual') {
    // Feature flag bypass — fall through to existing service
    if (!ENGINE_ENABLED) {
      return createAppointment(tenantId, body);
    }

    const errors = await validateBooking(tenantId, body);

    if (errors.length > 0) {
      // Log rejected attempt
      await logBookingAttempt({ tenantId, source, outcome: 'rejected', validationErrors: errors });
      const err = new Error(errors[0].message);
      err.code       = errors[0].code;
      err.statusCode = 422;
      err.errors     = errors;
      throw err;
    }

    // Validation passed — create the appointment
    const appointment = await createAppointment(tenantId, { ...body, source });

    // Log successful booking
    await logBookingAttempt({
      tenantId,
      appointmentId: appointment.id,
      source,
      outcome: 'allowed',
      validationErrors: null,
    });

    return appointment;
  },
};

// ─── Validation pipeline ──────────────────────────────────────────────────────
// Returns array of error objects. Empty array = all checks passed.

async function validateBooking(tenantId, body) {
  const errors = [];

  const { serviceId, staffId, date, time } = body;
  if (!date || !time) return errors; // Basic field validation handled by createAppointment

  // Parse the requested slot
  const [y, m, d] = date.split('-').map(Number);
  const [h, min]  = time.split(':').map(Number);
  const startsAt  = new Date(Date.UTC(y, m - 1, d, h, min, 0));
  const dayOfWeek = startsAt.getUTCDay(); // 0=Sun, 1=Mon...6=Sat

  // Fetch required data in parallel
  const [service, consultationRule, tenant, blackoutDate] = await Promise.all([
    serviceId
      ? prisma.service.findFirst({ where: { id: serviceId, tenantId, isActive: true } })
      : null,
    prisma.consultationRule.findUnique({ where: { tenantId } }),
    prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { settings: true },
    }),
    prisma.blackoutDate.findFirst({
      where: {
        tenantId,
        date: {
          gte: new Date(Date.UTC(y, m - 1, d, 0, 0, 0)),
          lte: new Date(Date.UTC(y, m - 1, d, 23, 59, 59)),
        },
      },
    }),
  ]);

  const settings = tenant?.settings ?? {};
  const endsAt   = service
    ? new Date(startsAt.getTime() + service.durationMins * 60_000)
    : null;

  // ── 1. Blackout date check ────────────────────────────────────────────────
  if (blackoutDate) {
    errors.push({
      code:    'BLACKOUT_DATE',
      field:   'date',
      message: `${date} is a blackout date${blackoutDate.reason ? ': ' + blackoutDate.reason : ''}. No bookings can be made on this day.`,
    });
    return errors; // Stop here — no point checking further for a blacked-out day
  }

  // ── 2. Operating hours check ─────────────────────────────────────────────
  const businessHours = settings.businessHours ?? {};
  const dayNames      = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayConfig     = businessHours[dayNames[dayOfWeek]];

  if (dayConfig && !dayConfig.isOpen) {
    errors.push({
      code:    'OUTSIDE_OPERATING_HOURS',
      field:   'date',
      message: `The clinic is closed on ${dayNames[dayOfWeek]}s.`,
    });
  } else if (dayConfig?.open && dayConfig?.close) {
    const [opH, opM] = dayConfig.open.split(':').map(Number);
    const [clH, clM] = dayConfig.close.split(':').map(Number);
    const openMins   = opH * 60 + opM;
    const closeMins  = clH * 60 + clM;
    const startMins  = h * 60 + min;

    if (startMins < openMins || startMins >= closeMins) {
      errors.push({
        code:    'OUTSIDE_OPERATING_HOURS',
        field:   'time',
        message: `Booking time ${time} is outside operating hours (${dayConfig.open}–${dayConfig.close}).`,
      });
    }
  }

  // ── 3. ConsultationRule checks (only if rule exists for this tenant) ─────
  if (consultationRule) {
    // 3a. Available days check
    const allowedDays = Array.isArray(consultationRule.availableDays)
      ? consultationRule.availableDays
      : [1, 2, 3, 4, 5];

    if (!allowedDays.includes(dayOfWeek)) {
      errors.push({
        code:    'OUTSIDE_CONSULTATION_DAYS',
        field:   'date',
        message: `Consultations are not available on ${dayNames[dayOfWeek]}s.`,
      });
    }

    // 3b. Time block check
    const timeBlocks = Array.isArray(consultationRule.timeBlocks)
      ? consultationRule.timeBlocks
      : [{ start: '09:00', end: '17:00' }];

    const inAllowedBlock = timeBlocks.some(block => {
      const [bsh, bsm] = block.start.split(':').map(Number);
      const [beh, bem] = block.end.split(':').map(Number);
      const blockStart = bsh * 60 + bsm;
      const blockEnd   = beh * 60 + bem;
      const slotStart  = h * 60 + min;
      return slotStart >= blockStart && slotStart < blockEnd;
    });

    if (!inAllowedBlock) {
      errors.push({
        code:    'OUTSIDE_CONSULTATION_HOURS',
        field:   'time',
        message: `${time} is outside the allowed consultation time blocks.`,
      });
    }

    // 3c. Max daily consultations
    const dayStart = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const dayEnd   = new Date(Date.UTC(y, m - 1, d, 23, 59, 59));

    const dailyCount = await prisma.appointment.count({
      where: {
        tenantId,
        startsAt: { gte: dayStart, lte: dayEnd },
        status:   { in: ['CONFIRMED', 'PENDING'] },
      },
    });

    if (dailyCount >= consultationRule.maxPerDay) {
      errors.push({
        code:    'MAX_DAILY_LIMIT',
        field:   'date',
        message: `Maximum consultation limit (${consultationRule.maxPerDay}) reached for ${date}.`,
      });
    }
  }

  // ── 4. Double-booking check (same staff, overlapping time) ───────────────
  if (staffId && endsAt) {
    const overlap = await prisma.appointment.findFirst({
      where: {
        tenantId,
        staffId,
        status:  { in: ['CONFIRMED', 'PENDING'] },
        AND: [
          { startsAt: { lt: endsAt   } },
          { endsAt:   { gt: startsAt } },
        ],
      },
      select: { id: true, startsAt: true, endsAt: true },
    });

    if (overlap) {
      errors.push({
        code:    'SLOT_TAKEN',
        field:   'time',
        message: `The selected staff member already has a booking overlapping ${time} on ${date}.`,
      });
    }
  }

  // ── 5. Buffer time check ─────────────────────────────────────────────────
  if (staffId && consultationRule?.bufferMins && endsAt) {
    const bufferMs     = consultationRule.bufferMins * 60_000;
    const bufferBefore = new Date(startsAt.getTime() - bufferMs);
    const bufferAfter  = new Date(endsAt.getTime()   + bufferMs);

    const tooClose = await prisma.appointment.findFirst({
      where: {
        tenantId,
        staffId,
        status:  { in: ['CONFIRMED', 'PENDING'] },
        AND: [
          { startsAt: { lt: bufferAfter   } },
          { endsAt:   { gt: bufferBefore  } },
        ],
      },
      select: { id: true },
    });

    if (tooClose) {
      errors.push({
        code:    'BUFFER_TIME_VIOLATION',
        field:   'time',
        message: `A minimum ${consultationRule.bufferMins}-minute buffer is required between appointments.`,
      });
    }
  }

  return errors;
}

// ─── Booking attempt log ──────────────────────────────────────────────────────

async function logBookingAttempt({ tenantId, appointmentId, source, outcome, validationErrors }) {
  try {
    await prisma.bookingEngineLog.create({
      data: {
        tenantId,
        appointmentId: appointmentId ?? null,
        source,
        outcome,
        validationErrors: validationErrors ?? undefined,
      },
    });
  } catch (err) {
    // Non-fatal — never block a booking because of a logging failure
    console.error('[BookingEngine] Failed to write log:', err.message);
  }
}
