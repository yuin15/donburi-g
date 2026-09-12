import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const limits = vi.hoisted(() => ({ maxDailySessions: 10, maxConcurrentSessions: 1 }));
vi.mock('./env', () => ({ env: limits }));
let claimQuota: typeof import('./quota').claimQuota;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
  limits.maxDailySessions = 10;
  limits.maxConcurrentSessions = 1;
  ({ claimQuota } = await import('./quota'));
});
afterEach(() => vi.useRealTimers());
const expiry = () => Date.now() + 60_000;

describe('invitation demo process limits', () => {
  it('admits only one simultaneous connection in this process', async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => claimQuota(`test-${i}`, expiry())));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('does not charge denied starts or reuse a ticket after cleanup', async () => {
    limits.maxDailySessions = 2;
    const release = await claimQuota('first', expiry());
    await expect(claimQuota('second', expiry())).rejects.toThrow('concurrent_session_limit');
    await release();
    await expect(claimQuota('first', expiry())).rejects.toThrow('ticket_reused');
    const secondRelease = await claimQuota('second', expiry());
    await secondRelease();
    await expect(claimQuota('third', expiry())).rejects.toThrow('daily_session_limit');
  });
  it('recovers expired leases and ignores late/repeated cleanup', async () => {
    const oldRelease = await claimQuota('first', expiry());
    vi.advanceTimersByTime(180_001);
    const release = await claimQuota('second', expiry());
    await oldRelease();
    await oldRelease();
    await expect(claimQuota('third', expiry())).rejects.toThrow('concurrent_session_limit');
    await release();
    await expect(claimQuota('third', expiry())).resolves.toBeTypeOf('function');
  });
  it('starts a fresh daily counter at UTC midnight', async () => {
    limits.maxDailySessions = 1;
    await (await claimQuota('first', expiry()))();
    await expect(claimQuota('second', expiry())).rejects.toThrow('daily_session_limit');
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    await expect(claimQuota('second', expiry())).resolves.toBeTypeOf('function');
  });
  it.each([NaN, Infinity, 0])('rejects invalid or expired tickets: %s', async (value) => {
    await expect(claimQuota('expired', value)).rejects.toThrow('ticket_expired');
  });
});
