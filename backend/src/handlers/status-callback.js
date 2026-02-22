// ─────────────────────────────────────────────────────────────────────────────
// handlers/status-callback.js
//
// Called by Twilio with call lifecycle events (ringing, answered, completed).
// Used to track call status and update call logs.
// ─────────────────────────────────────────────────────────────────────────────

import { getCallSession, updateCallSession, deleteCallSession } from '../services/session-store.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function statusCallbackHandler(request, reply) {
  const {
    CallSid,
    CallStatus,
    Duration,
    RecordingUrl,
    ErrorCode,
  } = request.body;

  request.log.info({ CallSid, CallStatus, Duration }, 'Call status update');

  try {
    const session = await getCallSession(CallSid);

    if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer') {
      // Save final call log to database
      if (session) {
        await prisma.callLog.updateMany({
          where: { callSid: CallSid },
          data: {
            twilioStatus: CallStatus,
            durationMs: Duration ? parseInt(Duration) * 1000 : session.durationMs || 0,
            endedAt: new Date(),
          },
        });

        // Clean up session
        await deleteCallSession(CallSid);
        request.log.info({ CallSid, CallStatus }, 'Call ended and session cleaned up');
      }
    } else {
      // Update session with current status
      if (session) {
        await updateCallSession(CallSid, {
          ...session,
          twilioStatus: CallStatus,
        });
      }
    }

    return reply.send({ status: 'ok' });
  } catch (err) {
    request.log.error({ err, CallSid }, 'Error handling status callback');
    // Still return 200 to Twilio so it doesn't retry
    return reply.send({ status: 'error', message: err.message });
  }
}
