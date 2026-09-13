import { env } from './env.js';

// Small invitation-only demo: these limits belong to one running process.
// Vercel restarts/scaling reset or split them; they are not an account-wide
// spending cap. No database or additional service account is required.
const active = new Map<string, number>();
const used = new Map<string, number>();
let day = '';
let starts = 0;

export async function claimQuota(sessionId: string, ticketExpiresAt: number): Promise<() => Promise<void>> {
  const now = Date.now();
  if (!Number.isSafeInteger(ticketExpiresAt) || ticketExpiresAt <= now) throw new Error('ticket_expired');
  for (const [id, expires] of active) if (expires <= now) active.delete(id);
  for (const [id, expires] of used) if (expires <= now) used.delete(id);
  const today = new Date(now).toISOString().slice(0, 10);
  if (day !== today) { day = today; starts = 0; }
  if (used.has(sessionId)) throw new Error('ticket_reused');
  if (starts >= env.maxDailySessions) throw new Error('daily_session_limit');
  if (active.size >= env.maxConcurrentSessions) throw new Error('concurrent_session_limit');
  // No await between checking and reserving: simultaneous requests in this
  // process cannot pass the limit together. Leases outlive the 170s teardown start.
  active.set(sessionId, now + 180_000);
  used.set(sessionId, Math.max(ticketExpiresAt, now + 180_000));
  starts += 1;
  return async () => { active.delete(sessionId); };
}
