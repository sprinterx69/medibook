// ─────────────────────────────────────────────────────────────────────────────
// services/calendar.js
//
// Real-time availability engine.
// Called by the LLM tool "check_availability" to find open slots.
//
// Algorithm:
//   1. Resolve the requested date (handles "tomorrow", "next Monday", etc.)
//   2. Find all staff who offer the requested service
//   3. Load their weekly availability (working hours)
//   4. Load all existing appointments for that day
//   5. Generate candidate slots at regular intervals
//   6. Filter out conflicts (existing bookings + buffer time)
//   7. Return the first N open slots with slot IDs
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
import {
  parseISO, format, addMinutes, isAfter, isBefore,
  startOfDay, endOfDay, setHours, setMinutes, parse,
} from 'date-fns';

const prisma = new PrismaClient();

const SLOT_INTERVAL_MINS = 15;   // Offer slots every 15 minutes
const MAX_SLOTS_TO_RETURN = 5;   // Return up to 5 options to the caller
const BUFFER_MINS = 10;          // Buffer between appointments

/**
 * Resolves natural language date strings to a JS Date.
 * Handles: YYYY-MM-DD, "tomorrow", "next Monday", "this Friday", etc.
 */
function resolveDate(dateStr) {
  if (!dateStr) return new Date();

  const lower = dateStr.toLowerCase().trim();
  const today = new Date();

  if (lower === 'today') return today;
  if (lower === 'tomorrow') {
    const d = new Date(); d.setDate(d.getDate() + 1); return d;
  }

  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayMatch = days.findIndex(d => lower.includes(d));
  if (dayMatch !== -1) {
    const d = new Date();
    const diff = (dayMatch + 7 - d.getDay()) % 7;
    d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
    return d;
  }

  // Try ISO date parse
  try {
    const parsed = parseISO(dateStr);
    if (!isNaN(parsed)) return parsed;
  } catch {}

  return today;
}

/**
 * Checks if a candidate slot conflicts with any existing appointment.
 */
function hasConflict(slotStart, durationMins, existingAppointments) {
  const slotEnd = addMinutes(slotStart, durationMins + BUFFER_MINS);

  return existingAppointments.some(appt => {
    const apptStart = new Date(appt.startsAt);
    const apptEnd = addMinutes(apptStart, appt.service.durationMins + BUFFER_MINS);

    return (
      (isAfter(slotStart, apptStart) && isBefore(slotStart, apptEnd)) ||
      (isAfter(slotEnd, apptStart)   && isBefore(slotEnd, apptEnd))   ||
      (isBefore(slotStart, apptStart) && isAfter(slotEnd, apptEnd))
    );
  });
}

/**
 * Main availability check function — called by LLM tool executor.
 *
 * @returns {Object} { available: boolean, slots: Array, message: string }
 */
export async function checkAvailability({ tenantId, serviceName, date, staffPreference }) {
  try {
    const resolvedDate = resolveDate(date);
    const dateLabel = format(resolvedDate, 'EEEE do MMMM');

    // ── 1. Find the service ──────────────────────────────────────────────
    const service = await prisma.service.findFirst({
      where: {
        tenantId,
        name: { contains: serviceName, mode: 'insensitive' },
        isActive: true,
      },
    });

    if (!service) {
      return {
        available: false,
        slots: [],
        message: `We don't currently offer "${serviceName}". Our services include Hydrafacial, Botox, Laser Treatments, Dermal Fillers, and Chemical Peels.`,
      };
    }

    // ── 2. Find available staff ──────────────────────────────────────────
    const staffQuery = {
      where: {
        tenantId,
        isActive: true,
        services: { some: { serviceId: service.id } },
        ...(staffPreference ? { name: { contains: staffPreference, mode: 'insensitive' } } : {}),
      },
      include: { availability: true },
    };
    const staffList = await prisma.staff.findMany(staffQuery);

    if (!staffList.length) {
      return {
        available: false,
        slots: [],
        message: `Sorry, no staff are available for ${serviceName}${staffPreference ? ` with ${staffPreference}` : ''}.`,
      };
    }

    const dayOfWeek = resolvedDate.getDay(); // 0=Sun, 6=Sat
    const slots = [];

    // ── 3. For each staff member, generate open slots ────────────────────
    for (const staff of staffList) {
      const todayAvail = staff.availability.filter(a => a.dayOfWeek === dayOfWeek);
      if (!todayAvail.length) continue; // Staff doesn't work this day

      // Load existing appointments for this staff on this date
      const existingAppts = await prisma.appointment.findMany({
        where: {
          tenantId,
          staffId: staff.id,
          startsAt: {
            gte: startOfDay(resolvedDate),
            lte: endOfDay(resolvedDate),
          },
          status: { notIn: ['cancelled'] },
        },
        include: { service: { select: { durationMins: true } } },
      });

      // Generate candidate slots across all working windows
      for (const window of todayAvail) {
        let cursor = setMinutes(
          setHours(new Date(resolvedDate), parseInt(window.startTime.split(':')[0])),
          parseInt(window.startTime.split(':')[1])
        );
        const windowEnd = setMinutes(
          setHours(new Date(resolvedDate), parseInt(window.endTime.split(':')[0])),
          parseInt(window.endTime.split(':')[1])
        );

        // Skip past times (if checking today)
        const now = new Date();
        if (isBefore(cursor, now)) {
          cursor = addMinutes(now, SLOT_INTERVAL_MINS - (now.getMinutes() % SLOT_INTERVAL_MINS));
        }

        while (isBefore(addMinutes(cursor, service.durationMins), windowEnd)) {
          if (!hasConflict(cursor, service.durationMins, existingAppts)) {
            slots.push({
              id: `${staff.id}_${cursor.toISOString()}`,
              staffId: staff.id,
              staffName: staff.name,
              startsAt: cursor.toISOString(),
              label: `${format(cursor, 'h:mm a')} with ${staff.name}`,
            });

            if (slots.length >= MAX_SLOTS_TO_RETURN) break;
          }
          cursor = addMinutes(cursor, SLOT_INTERVAL_MINS);
        }

        if (slots.length >= MAX_SLOTS_TO_RETURN) break;
      }

      if (slots.length >= MAX_SLOTS_TO_RETURN) break;
    }

    if (!slots.length) {
      return {
        available: false,
        slots: [],
        message: `Unfortunately we have no availability for ${serviceName} on ${dateLabel}. Would you like me to check another day?`,
      };
    }

    // Format slot list for the LLM to read to the caller
    const slotList = slots.map((s, i) => `Option ${i + 1}: ${s.label}`).join('. ');

    return {
      available: true,
      slots,
      message: `For ${serviceName} on ${dateLabel}, I have: ${slotList}. Which would you prefer?`,
      serviceName: service.name,
      durationMins: service.durationMins,
      priceCents: service.priceCents,
    };

  } catch (err) {
    console.error('checkAvailability error:', err);
    return {
      available: false,
      slots: [],
      message: 'I\'m having trouble checking the calendar right now. Please call back in a moment.',
    };
  }
}
