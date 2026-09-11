import { env } from './env';

// Redis owns the clock. Admission is atomic and leases survive process crashes
// for at most 180 seconds. All keys share one Redis Cluster slot.
const admissionScript = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if now >= tonumber(ARGV[2]) then return -4 end
if redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local day = math.floor(now / 86400000)
local count = 0
if tonumber(redis.call('HGET', KEYS[1], 'day')) == day then
  count = tonumber(redis.call('HGET', KEYS[1], 'count')) or 0
end
if count >= tonumber(ARGV[3]) then return -2 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return -3 end
redis.call('HSET', KEYS[1], 'day', day, 'count', count + 1)
redis.call('EXPIRE', KEYS[1], 172800)
redis.call('ZADD', KEYS[2], now + 180000, ARGV[1])
redis.call('EXPIRE', KEYS[2], 180)
redis.call('SET', KEYS[3], '1', 'EX', 180)
return 1
`;

const activeKey = 'slot-chan:{quota}:active';

async function command(args: Array<string | number>): Promise<number> {
  if (!env.quotaUrl || !env.quotaToken) throw new Error('shared_quota_not_configured');
  const response = await fetch(env.quotaUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.quotaToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`quota_store_http_${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || 'error' in body ||
      !('result' in body) || typeof body.result !== 'number' || !Number.isSafeInteger(body.result)) {
    throw new Error('quota_store_invalid_response');
  }
  return body.result;
}

export async function claimQuota(sessionId: string, ticketExpiresAt: number): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(ticketExpiresAt) || ticketExpiresAt <= Date.now()) throw new Error('ticket_expired');
  const result = await command([
    'EVAL', admissionScript, 3,
    'slot-chan:{quota}:daily', activeKey, `slot-chan:{quota}:used:${sessionId}`,
    sessionId, ticketExpiresAt, env.maxDailySessions, env.maxConcurrentSessions,
  ]);
  const errors: Record<number, string> = {
    [-1]: 'ticket_reused', [-2]: 'daily_session_limit',
    [-3]: 'concurrent_session_limit', [-4]: 'ticket_expired',
  };
  if (result !== 1) throw new Error(errors[result] ?? 'quota_store_invalid_response');

  let released = false;
  let releasing: Promise<void> | undefined;
  return () => {
    if (released) return Promise.resolve();
    // Retain the replay marker after release. ZREM can safely be retried after
    // a timeout, without decrementing another session's lease.
    releasing ??= command(['ZREM', activeKey, sessionId]).then((removed) => {
      if (removed !== 0 && removed !== 1) throw new Error('quota_store_invalid_response');
      released = true;
    }).finally(() => { releasing = undefined; });
    return releasing;
  };
}
