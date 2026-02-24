// ─────────────────────────────────────────────────────────────────────────────
// services/transcript.js
//
// Handles saving call transcripts and conversation history to the database.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

/**
 * Saves or updates a call transcript in the database.
 * @param {Object} params
 * @param {string} params.callSid - Twilio call SID
 * @param {string} params.tenantId - Clinic tenant ID
 * @param {Array} params.transcript - Array of { role, content } messages
 * @param {number} params.durationMs - Call duration in milliseconds
 * @param {string} params.callerPhone - Caller's phone number
 * @param {number} params.bookingsMade - Number of bookings made during call
 */
export async function saveCallTranscript({
  callSid,
  tenantId,
  transcript = [],
  durationMs = 0,
  callerPhone = null,
  bookingsMade = 0,
}) {
  try {
    // Check if call log already exists
    const existing = await prisma.callLog.findUnique({
      where: { callSid },
    });

    if (existing) {
      // Update existing log
      return await prisma.callLog.update({
        where: { callSid },
        data: {
          transcript: transcript,
          durationMs: durationMs,
          bookingsMade: bookingsMade,
          callerPhone: callerPhone || existing.callerPhone,
        },
      });
    } else {
      // Create new log
      return await prisma.callLog.create({
        data: {
          callSid,
          tenantId,
          transcript: transcript,
          durationMs,
          callerPhone,
          bookingsMade,
          twilioStatus: 'in-progress',
        },
      });
    }
  } catch (err) {
    console.error('Error saving call transcript:', err);
    throw err;
  }
}

/**
 * Updates call transcript with new messages during an active call.
 * @param {string} callSid - Twilio call SID
 * @param {Array} newMessages - New messages to append
 */
export async function appendToTranscript(callSid, newMessages) {
  try {
    const existing = await prisma.callLog.findUnique({
      where: { callSid },
      select: { transcript: true },
    });

    const currentTranscript = existing?.transcript || [];
    const updatedTranscript = [...currentTranscript, ...newMessages];

    return await prisma.callLog.update({
      where: { callSid },
      data: { transcript: updatedTranscript },
    });
  } catch (err) {
    console.error('Error appending to transcript:', err);
    throw err;
  }
}

/**
 * Retrieves a call transcript for review.
 * @param {string} callSid - Twilio call SID
 */
export async function getCallTranscript(callSid) {
  return await prisma.callLog.findUnique({
    where: { callSid },
    include: {
      tenant: {
        select: { name: true, slug: true },
      },
    },
  });
}

/**
 * Gets all call transcripts for a tenant with pagination.
 * @param {string} tenantId - Clinic tenant ID
 * @param {Object} options - Query options
 * @param {number} options.limit - Max results
 * @param {number} options.offset - Skip results
 */
export async function getTenantCallLogs(tenantId, { limit = 50, offset = 0 } = {}) {
  return await prisma.callLog.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}
