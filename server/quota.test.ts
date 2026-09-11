import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimQuota } from './quota';

vi.mock('./env', () => ({ env: {
  quotaUrl: 'https://quota.invalid', quotaToken: 'test-token',
  maxDailySessions: 100, maxConcurrentSessions: 5,
} }));
const transport = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', transport); transport.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe('quota transport failure boundaries', () => {
  it.each([{}, { result: '1' }, { result: null }, { result: 2 }, { result: 1, error: 'failure' }])(
    'rejects malformed store data: %j', async (body) => {
      transport.mockResolvedValue(Response.json(body));
      await expect(claimQuota('test', Date.now() + 60_000)).rejects.toThrow('quota_store_invalid_response');
    },
  );
  it('rejects an expired ticket before sending a request', async () => {
    await expect(claimQuota('test', Date.now())).rejects.toThrow('ticket_expired');
    expect(transport).not.toHaveBeenCalled();
  });
  it('bounds store requests and surfaces HTTP failures', async () => {
    transport.mockResolvedValue(new Response('', { status: 503 }));
    await expect(claimQuota('test', Date.now() + 60_000)).rejects.toThrow('quota_store_http_503');
    expect(transport.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('retries a failed release and coalesces simultaneous cleanup', async () => {
    transport.mockResolvedValueOnce(Response.json({ result: 1 }));
    const release = await claimQuota('test', Date.now() + 60_000);
    transport.mockRejectedValueOnce(new Error('timeout'));
    await expect(release()).rejects.toThrow('timeout');
    transport.mockResolvedValueOnce(Response.json({ result: 0 }));
    await Promise.all([release(), release()]);
    await release();
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
