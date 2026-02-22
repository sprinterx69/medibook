// ─────────────────────────────────────────────────────────────────────────────
// services/session-store.js
//
// In-memory call session store.
// Holds active call state: conversation history, tenant context, metadata.
// Sessions are created on call start and deleted after call ends.
//
// In production: replace with Redis for multi-instance deployments.
// ─────────────────────────────────────────────────────────────────────────────

const sessions = new Map();

export async function createCallSession(data) {
  sessions.set(data.callSid, { ...data, createdAt: new Date() });
  return sessions.get(data.callSid);
}

export async function getCallSession(callSid) {
  return sessions.get(callSid) ?? null;
}

export async function updateCallSession(callSid, updates) {
  const existing = sessions.get(callSid);
  if (!existing) return null;
  const updated = { ...existing, ...updates };
  sessions.set(callSid, updated);
  return updated;
}

export async function deleteCallSession(callSid) {
  sessions.delete(callSid);
}

// Cleanup sessions older than 2 hours (in case of dangling sessions)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [sid, sess] of sessions.entries()) {
    if (sess.createdAt.getTime() < cutoff) sessions.delete(sid);
  }
}, 30 * 60 * 1000);
