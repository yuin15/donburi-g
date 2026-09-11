import { env } from './env';

interface RedisResponse<T> {
  result?: T;
  error?: string;
}

async function command<T>(args: Array<string | number>): Promise<T> {
  if (!env.quotaUrl || !env.quotaToken) throw new Error('shared_quota_not_configured');
  const response = await fetch(env.quotaUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.quotaToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`quota_store_http_${response.status}`);
  const body = (await response.json()) as RedisResponse<T>;
  if (body.error) throw new Error('quota_store_command_failed');
  return body.result as T;
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function claimQuota(sessionId: string): Promise<() => Promise<void>> {
  const dailyKey = `reelforge:daily:${dayKey()}`;
  const concurrentKey = 'reelforge:concurrent';
  const leaseKey = `reelforge:lease:${sessionId}`;

  const already = await command<number>(['SET', leaseKey, '1', 'NX', 'EX', 180]);
  if (already === null) throw new Error('ticket_reused');

  const daily = Number(await command<number>(['INCR', dailyKey]));
  if (daily === 1) await command<number>(['EXPIRE', dailyKey, 172800]);
  if (daily > env.maxDailySessions) {
    await command<number>(['DEL', leaseKey]);
    throw new Error('daily_session_limit');
  }

  const concurrent = Number(await command<number>(['INCR', concurrentKey]));
  if (concurrent > env.maxConcurrentSessions) {
    await command<number>(['DECR', concurrentKey]);
    await command<number>(['DEL', leaseKey]);
    throw new Error('concurrent_session_limit');
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await Promise.allSettled([
      command<number>(['DECR', concurrentKey]),
      command<number>(['DEL', leaseKey]),
    ]);
  };
}
