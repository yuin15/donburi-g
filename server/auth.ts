import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

interface TicketPayload {
  sid: string;
  origin: string;
  exp: number;
  nonce: string;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(encoded: string): string {
  if (env.signingKey.length < 24) throw new Error('SESSION_SIGNING_KEY must be at least 24 characters');
  return createHmac('sha256', env.signingKey).update(encoded).digest('base64url');
}

export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  const candidates = new Set(env.allowedOrigins);
  if (env.vercelUrl) candidates.add(`https://${env.vercelUrl}`);
  if (candidates.size > 0) return candidates.has(origin);
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function issueTicket(inviteCode: string, origin: string): string {
  if (!env.liveEnabled) throw new Error('live_mode_disabled');
  if (!env.inviteCode || !safeEqual(inviteCode, env.inviteCode)) throw new Error('invalid_invite_code');
  const payload: TicketPayload = {
    sid: randomUUID(),
    origin,
    exp: Date.now() + 60_000,
    nonce: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function verifyTicket(ticket: string, origin: string): TicketPayload {
  if (!env.liveEnabled) throw new Error('live_mode_disabled');
  const [encoded, signature, extra] = ticket.split('.');
  if (!encoded || !signature || extra) throw new Error('invalid_ticket');
  if (!safeEqual(signature, sign(encoded))) throw new Error('invalid_ticket_signature');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TicketPayload;
  if (!payload.sid || !payload.nonce || !payload.origin || !payload.exp) throw new Error('invalid_ticket_payload');
  if (payload.exp <= Date.now()) throw new Error('expired_ticket');
  if (payload.origin !== origin) throw new Error('ticket_origin_mismatch');
  return payload;
}
