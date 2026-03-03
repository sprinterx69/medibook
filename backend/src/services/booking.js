// ─────────────────────────────────────────────────────────────────────────────
// services/booking.js
//
// Booking operations called by LLM tool executor:
//   bookAppointment       — creates a new appointment + sends confirmation SMS
//   cancelAppointment     — cancels an existing appointment
//   rescheduleAppointment — moves a booking to a new slot
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';
import { format, parseISO } from 'date-fns';
import twilio from 'twilio';
import { BookingEngine } from './booking-engine.js';

const ENGINE_ENABLED = process.env.BOOKING_ENGINE_ENABLED === 'true';

// Lazy-load Twilio client to ensure env vars are loaded
let twilioClient;
function getTwilio() {
  if (!twilioClient) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return twilioClient;
}

// ─── Book Appointment ─────────────────────────────────────────────────────────
/**
 * Creates a new appointment from a confirmed slot.
 * Slot IDs are formatted as: `{staffId}_{isoDatetime}`
 *
 * After booking:
 *   - Sends confirmation SMS to the caller
 *   - Queues a reminder job (handled by BullMQ worker, not this service)
 */
export async function bookAppointment({
  tenantId,
  callerNumber,
  callerName,
  serviceName,
  slotId,
  notes = '',
}) {
  // Parse slot ID
  const [staffId, isoDatetime] = slotId.split('_');
  if (!staffId || !isoDatetime) {
    throw new Error('Invalid slot ID format. Expected: {staffId}_{isoDatetime}');
  }

  const startsAt = new Date(isoDatetime);
  if (isNaN(startsAt.getTime())) {
    throw new Error('Invalid datetime in slot ID');
  }

  // Fetch service to get duration
  const service = await prisma.service.findFirst({
    where: { tenantId, name: serviceName, isActive: true },
    select: { id: true, durationMins: true, priceCents: true },
  });

  if (!service) {
    throw new Error(`Service "${serviceName}" not found`);
  }

  // Run BookingEngine validation (when enabled) before any DB writes
  if (ENGINE_ENABLED) {
    const date = startsAt.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const time = `${String(startsAt.getUTCHours()).padStart(2, '0')}:${String(startsAt.getUTCMinutes()).padStart(2, '0')}`;
    await BookingEngine.createAppointment(
      tenantId,
      { clientName: callerName, clientPhone: callerNumber, serviceId: service.id, staffId, date, time, notes },
      'ai'
    );
    // If we get here, validation passed and appointment was already created by BookingEngine.
    // Return the result that was created inside BookingEngine.
    // Note: BookingEngine.createAppointment already calls createAppointment internally — do not double-create.
    // So if engine is enabled we return early after the engine creates the appointment.
    const created = await prisma.appointment.findFirst({
      where: { tenantId, staffId, startsAt, status: { not: 'CANCELLED' } },
      include: {
        client:  { select: { fullName: true, phone: true } },
        staff:   { select: { name: true } },
        service: { select: { name: true, durationMins: true } },
      },
    });
    return {
      success:       true,
      appointmentId: created?.id,
      startsAt,
      endsAt:        new Date(startsAt.getTime() + service.durationMins * 60 * 1000),
      message:       `Confirmed! Your appointment is on ${format(startsAt, 'MMMM do')} at ${format(startsAt, 'h:mm a')}.`,
    };
  }

  // Calculate end time
  const endsAt = new Date(startsAt.getTime() + service.durationMins * 60 * 1000);

  // Find or create client
  let client = await prisma.client.findFirst({
    where: { tenantId, phone: callerNumber },
    select: { id: true },
  });

  if (!client) {
    client = await prisma.client.create({
      data: {
        tenantId,
        phone: callerNumber,
        fullName: callerName || 'Unknown',
      },
      select: { id: true },
    });
  }

  // Check for double-booking
  const existing = await prisma.appointment.findFirst({
    where: {
      tenantId,
      staffId,
      startsAt,
      status: { not: 'CANCELLED' },
    },
  });

  if (existing) {
    throw new Error('Slot no longer available');
  }

  // Create appointment
  const appointment = await prisma.appointment.create({
    data: {
      tenantId,
      clientId: client.id,
      staffId,
      serviceId: service.id,
      startsAt,
      endsAt,
      status: 'CONFIRMED',
      source: 'VOICE',
      notes,
    },
    include: {
      client: { select: { fullName: true, phone: true } },
      staff: { select: { name: true } },
      service: { select: { name: true, durationMins: true } },
    },
  });

  // Send confirmation SMS
  try {
    await getTwilio().messages.create({
      body: `Hi ${appointment.client.fullName}, your ${appointment.service.name} appointment with ${appointment.staff.name} is confirmed for ${format(startsAt, 'MMM d')} at ${format(startsAt, 'h:mm a')}. Reply CANCEL to cancel.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: appointment.client.phone,
    });
  } catch (smsErr) {
    console.error('Failed to send confirmation SMS:', smsErr.message);
    // Don't fail the booking if SMS fails
  }

  return {
    success: true,
    appointmentId: appointment.id,
    startsAt,
    endsAt,
    message: `Confirmed! Your appointment is on ${format(startsAt, 'MMMM do')} at ${format(startsAt, 'h:mm a')}.`,
  };
}

// ─── Cancel Appointment ───────────────────────────────────────────────────────
/**
 * Cancels an appointment by ID.
 */
export async function cancelAppointment({ tenantId, appointmentId, reason = '' }) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    include: {
      client: { select: { fullName: true, phone: true } },
      staff: { select: { name: true } },
      service: { select: { name: true } },
    },
  });

  if (!appointment) {
    throw new Error('Appointment not found');
  }

  if (appointment.status === 'CANCELLED') {
    throw new Error('Appointment already cancelled');
  }

  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: 'CANCELLED', notes: `${appointment.notes}\n\nCancelled: ${reason}`.trim() },
  });

  // Send cancellation SMS
  try {
    await getTwilio().messages.create({
      body: `Hi ${appointment.client.fullName}, your ${appointment.service.name} appointment on ${format(appointment.startsAt, 'MMM d')} at ${format(appointment.startsAt, 'h:mm a')} has been cancelled.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: appointment.client.phone,
    });
  } catch (smsErr) {
    console.error('Failed to send cancellation SMS:', smsErr.message);
  }

  return { success: true, message: 'Appointment cancelled' };
}

// ─── Reschedule Appointment ───────────────────────────────────────────────────
/**
 * Moves an existing appointment to a new slot.
 */
export async function rescheduleAppointment({
  tenantId,
  appointmentId,
  newSlotId,
  reason = '',
}) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    include: {
      client: { select: { fullName: true, phone: true } },
      staff: { select: { name: true } },
      service: { select: { name: true, durationMins: true } },
    },
  });

  if (!appointment) {
    throw new Error('Appointment not found');
  }

  // Parse new slot
  const [newStaffId, newIsoDatetime] = newSlotId.split('_');
  if (!newStaffId || !newIsoDatetime) {
    throw new Error('Invalid new slot ID format');
  }

  const newStartsAt = new Date(newIsoDatetime);
  if (isNaN(newStartsAt.getTime())) {
    throw new Error('Invalid datetime in new slot ID');
  }

  const newEndsAt = new Date(newStartsAt.getTime() + appointment.service.durationMins * 60 * 1000);

  // Check for double-booking
  const existing = await prisma.appointment.findFirst({
    where: {
      tenantId,
      staffId: newStaffId,
      startsAt: newStartsAt,
      status: { not: 'CANCELLED' },
      id: { not: appointmentId },
    },
  });

  if (existing) {
    throw new Error('New slot no longer available');
  }

  // Update appointment
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      staffId: newStaffId,
      startsAt: newStartsAt,
      endsAt: newEndsAt,
      notes: `${appointment.notes}\n\nRescheduled: ${reason}`.trim(),
    },
  });

  // Send rescheduling SMS
  try {
    await getTwilio().messages.create({
      body: `Hi ${appointment.client.fullName}, your ${appointment.service.name} appointment has been rescheduled to ${format(newStartsAt, 'MMM d')} at ${format(newStartsAt, 'h:mm a')}.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: appointment.client.phone,
    });
  } catch (smsErr) {
    console.error('Failed to send rescheduling SMS:', smsErr.message);
  }

  return {
    success: true,
    message: `Rescheduled to ${format(newStartsAt, 'MMMM do')} at ${format(newStartsAt, 'h:mm a')}.`,
  };
}
