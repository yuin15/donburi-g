import { createClient } from '@redis/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimQuota } from './quota';
import { env } from './env';

vi.mock('./env', () => ({ env: {
  quotaUrl: 'https://quota.invalid', quotaToken: 'test-token',
  maxDailySessions: 100, maxConcurrentSessions: 2,
} }));

// Use only a dedicated local Redis database. The CI job provisions its own
// instance; without REDIS_TEST_PORT, this suite is explicitly skipped.
describe.skipIf(!process.env.REDIS_TEST_PORT)('quota admission against real Redis', () => {
  const redis = createClient({
    socket: { host: '127.0.0.1', port: Number(process.env.REDIS_TEST_PORT), reconnectStrategy: false },
    database: 15,
  });
  const active = 'slot-chan:{quota}:active';
  const daily = 'slot-chan:{quota}:daily';
  const ids = Array.from({ length: 20 }, (_, i) => `quota-test-${i}`);
  const keys = [active, daily, ...ids.map((id) => `slot-chan:{quota}:used:${id}`)];
  const expiry = () => Date.now() + 60_000;
  beforeAll(async () => { await redis.connect(); });
  afterAll(async () => { if (redis.isOpen) { await redis.del(keys); await redis.quit(); } });
  beforeEach(async () => {
    await redis.del(keys);
    env.maxDailySessions = 100;
    env.maxConcurrentSessions = 2;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const args = JSON.parse(String(options.body)) as Array<string | number>;
      const result = await redis.sendCommand(args.map(String));
      return Response.json({ result });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('admits only two of twenty simultaneous requests without charging denials', async () => {
    const results = await Promise.allSettled(ids.map((id) => claimQuota(id, expiry())));
    const admitted = results.filter((r) => r.status === 'fulfilled');
    expect(admitted).toHaveLength(2);
    expect(await redis.zCard(active)).toBe(2);
    expect(await redis.hGet(daily, 'count')).toBe('2');
    await Promise.all(admitted.map((r) => r.value()));
    expect(await redis.zCard(active)).toBe(0);
  });
  it('keeps used tickets invalid after normal cleanup', async () => {
    const release = await claimQuota(ids[0], expiry());
    await release();
    await expect(claimQuota(ids[0], expiry())).rejects.toThrow('ticket_reused');
    expect(await redis.ttl(`slot-chan:{quota}:used:${ids[0]}`)).toBeGreaterThan(60);
  });
  it('recovers an abandoned expired lease and ignores its late release', async () => {
    env.maxConcurrentSessions = 1;
    const oldRelease = await claimQuota(ids[0], expiry());
    await redis.zAdd(active, { score: 0, value: ids[0] });
    const currentRelease = await claimQuota(ids[1], expiry());
    await oldRelease();
    expect(await redis.zRange(active, 0, -1)).toEqual([ids[1]]);
    await currentRelease();
    expect(await redis.zCard(active)).toBe(0);
  });
  it('enforces the daily limit after release and resets on the Redis UTC day', async () => {
    env.maxDailySessions = 1;
    const release = await claimQuota(ids[0], expiry());
    await release();
    await expect(claimQuota(ids[1], expiry())).rejects.toThrow('daily_session_limit');
    await redis.hSet(daily, 'day', '-1');
    await claimQuota(ids[1], expiry());
    expect(await redis.hGet(daily, 'count')).toBe('1');
  });
  it('rechecks expiry inside Redis after an admission request is delayed', async () => {
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow - 120_000);
    try {
      await expect(claimQuota(ids[0], realNow - 60_000)).rejects.toThrow('ticket_expired');
      expect(await redis.exists(daily)).toBe(0);
    } finally { clock.mockRestore(); }
  });
});
