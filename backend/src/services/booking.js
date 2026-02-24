// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from '../config/prisma.js';
// services/booking.js
//
// Booking operations called by LLM tool executor:
//   bookAppointment       — creates a new appointment + sends confirmation SMS
//   cancelAppointment     — cancels an existing appointment
//   rescheduleAppointment — moves a booking to a new slot
// ─────────────────────────────────────────────────────────────────────────────


import { format, parseISO } from 'date-fns';
import twilio from 'twilio';


const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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
  tenantId, serviceName, slotId, clientName, clientPhone, notes,
}) {
  try {
    // ── 1. Parse slot ID ───────────────────────────────────────────────
    const [staffId, isoTime] = slotId.split('_');
    if (!staffId || !isoTime) {
      return { success: false, message: 'Invalid slot ID. Please try checking availability again.' };
    }
    const startsAt = parseISO(isoTime);

    // ── 2. Find the service ────────────────────────────────────────────
    const service = await prisma.service.findFirst({
      where: { tenantId, name: { contains: serviceName, mode: 'insensitive' }, isActive: true },
    });
    if (!service) {
      return { success: false, message: `Service "${serviceName}" not found.` };
    }

    // ── 3. Find or create client ───────────────────────────────────────
    let client = await prisma.client.findFirst({
      where: { tenantId, phone: clientPhone },
    });

    if (!client) {
      client = await prisma.client.create({
        data: {
          tenantId,
          fullName: clientName,
          phone: clientPhone,
          source: 'voice_agent',
        },
      });
    }

    // ── 4. Find staff ──────────────────────────────────────────────────
    const staff = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff) {
      return { success: false, message: 'Selected staff member not found.' };
    }

    // ── 5. Create appointment (with optimistic lock to prevent double-booking) ──
    const endsAt = new Date(startsAt.getTime() + service.durationMins * 60_000);

    // Check one final time that the slot is still free
    const conflict = await prisma.appointment.findFirst({
      where: {
        tenantId,
        staffId,
        status: { notIn: ['cancelled'] },
        OR: [
          { startsAt: { gte: startsAt, lt: endsAt } },
          { endsAt:   { gt: startsAt, lte: endsAt } },
          { startsAt: { lte: startsAt }, endsAt: { gte: endsAt } },
        ],
      },
    });

    if (conflict) {
      return {
        success: false,
        message: `That slot was just taken. Let me find another available time for you.`,
      };
    }

    const appointment = await prisma.appointment.create({
      data: {
        tenantId,
        clientId: client.id,
        staffId,
        serviceId: service.id,
        startsAt,
        endsAt,
        status: 'confirmed',
        source: 'voice_agent',
        notes: notes ?? null,
        depositRequired: service.depositCents > 0,
      },
    });

    // ── 6. Send confirmation SMS ───────────────────────────────────────
    const dateLabel = format(startsAt, "EEEE do MMMM 'at' h:mm a");
    const smsBody =
      `✅ Booking confirmed at MediBook!\n` +
      `${service.name} on ${dateLabel}\n` +
      `with ${staff.name}.\n` +
      `Reply CANCEL to cancel or call us to reschedule.`;

    try {
      await twilioClient.messages.create({
        body: smsBody,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: clientPhone,
      });
    } catch (smsErr) {
      // Don't fail the booking if SMS fails
      console.error('SMS confirmation failed:', smsErr.message);
    }

    return {
      success: true,
      appointmentId: appointment.id,
      message: `Booked! ${clientName} is confirmed for ${service.name} on ${dateLabel} with ${staff.name}. A confirmation text has been sent to ${clientPhone}.`,
      details: {
        service: service.name,
        staff: staff.name,
        date: dateLabel,
        duration: `${service.durationMins} minutes`,
        price: `£${(service.priceCents / 100).toFixed(2)}`,
      },
    };

  } catch (err) {
    console.error('bookAppointment error:', err);
    return {
      success: false,
      message: 'I was unable to complete the booking due to a technical issue. Please try again.',
    };
  }
}

// ─── Cancel Appointment ───────────────────────────────────────────────────────
export async function cancelAppointment({ tenantId, clientPhone, appointmentId, reason }) {
  try {
    // Find the appointment (by ID or by client phone → latest upcoming)
    let appointment;

    if (appointmentId) {
      appointment = await prisma.appointment.findFirst({
        where: { id: appointmentId, tenantId, status: { notIn: ['cancelled'] } },
        include: { service: true, staff: true, client: true },
      });
    } else {
      const client = await prisma.client.findFirst({ where: { tenantId, phone: clientPhone } });
      if (!client) {
        return { success: false, message: `I couldn't find any bookings for the number ${clientPhone}.` };
      }
      appointment = await prisma.appointment.findFirst({
        where: {
          tenantId,
          clientId: client.id,
          status: { notIn: ['cancelled', 'completed'] },
          startsAt: { gte: new Date() },
        },
        orderBy: { startsAt: 'asc' },
        include: { service: true, staff: true, client: true },
      });
    }

    if (!appointment) {
      return { success: false, message: `No upcoming appointments found. If you think this is an error, please call back during business hours.` };
    }

    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'cancelled', cancelledAt: new Date(), cancellationReason: reason ?? null },
    });

    const dateLabel = format(new Date(appointment.startsAt), "EEEE do MMMM 'at' h:mm a");

    // Send cancellation SMS
    try {
      await twilioClient.messages.create({
        body: `Your ${appointment.service.name} appointment on ${dateLabel} has been cancelled. Call us to rebook.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: clientPhone,
      });
    } catch {}

    return {
      success: true,
      message: `Done — your ${appointment.service.name} on ${dateLabel} with ${appointment.staff.name} has been cancelled. Is there anything else I can help you with?`,
    };

  } catch (err) {
    console.error('cancelAppointment error:', err);
    return { success: false, message: 'Unable to process the cancellation. Please call back during business hours.' };
  }
}

// ─── Reschedule Appointment ───────────────────────────────────────────────────
export async function rescheduleAppointment({ tenantId, clientPhone, appointmentId, newSlotId }) {
  try {
    // Find the existing appointment
    let existing;
    if (appointmentId) {
      existing = await prisma.appointment.findFirst({
        where: { id: appointmentId, tenantId },
        include: { service: true, staff: true },
      });
    } else {
      const client = await prisma.client.findFirst({ where: { tenantId, phone: clientPhone } });
      if (!client) return { success: false, message: 'No bookings found for that number.' };
      existing = await prisma.appointment.findFirst({
        where: { tenantId, clientId: client.id, status: 'confirmed', startsAt: { gte: new Date() } },
        orderBy: { startsAt: 'asc' },
        include: { service: true, staff: true },
      });
    }

    if (!existing) return { success: false, message: 'No upcoming appointment found to reschedule.' };

    // Parse the new slot
    const [newStaffId, newIsoTime] = newSlotId.split('_');
    const newStartsAt = parseISO(newIsoTime);
    const newEndsAt = new Date(newStartsAt.getTime() + existing.service.durationMins * 60_000);

    // Update the appointment
    const updated = await prisma.appointment.update({
      where: { id: existing.id },
      data: {
        staffId: newStaffId,
        startsAt: newStartsAt,
        endsAt: newEndsAt,
        status: 'confirmed',
      },
      include: { staff: true },
    });

    const newDateLabel = format(newStartsAt, "EEEE do MMMM 'at' h:mm a");

    try {
      await twilioClient.messages.create({
        body: `Your ${existing.service.name} has been rescheduled to ${newDateLabel} with ${updated.staff.name}. See you then!`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: clientPhone,
      });
    } catch {}

    return {
      success: true,
      message: `Done! Your ${existing.service.name} has been moved to ${newDateLabel} with ${updated.staff.name}. A confirmation text has been sent.`,
    };

  } catch (err) {
    console.error('rescheduleAppointment error:', err);
    return { success: false, message: 'Unable to reschedule. Please call back during business hours.' };
  }
}
