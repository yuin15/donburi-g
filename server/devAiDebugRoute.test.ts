import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleResponsesProbe, isTrustedDevProbeRequest } from './devAiDebugRoute';

function request(overrides: { host?: string; origin?: string; fetchSite?: string; remoteAddress?: string } = {}): IncomingMessage {
  return {
    method: 'POST',
    headers: {
      host: overrides.host ?? '127.0.0.1:5173',
      origin: overrides.origin ?? 'http://127.0.0.1:5173',
      'sec-fetch-site': overrides.fetchSite ?? 'same-origin',
    },
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function response(): { value: ServerResponse; status(): number; body(): string } {
  let statusCode = 0;
  let body = '';
  return {
    value: {
      set statusCode(value: number) { statusCode = value; },
      get statusCode() { return statusCode; },
      setHeader: vi.fn(),
      end: vi.fn((value: string) => { body = value; }),
    } as unknown as ServerResponse,
    status: () => statusCode,
    body: () => body,
  };
}

describe('development Responses probe guard', () => {
  it('accepts a loopback same-origin browser request', async () => {
    expect(isTrustedDevProbeRequest(request())).toBe(true);
    const res = response();
    const probe = vi.fn(async () => ({ state: 'connected' }));
    await handleResponsesProbe(request(), res.value, probe);
    expect(probe).toHaveBeenCalledOnce();
    expect(res.status()).toBe(200);
    expect(res.body()).toBe('{"state":"connected"}');
  });

  it.each([
    { origin: 'https://evil.example' },
    { fetchSite: 'cross-site' },
    { remoteAddress: '192.168.1.20' },
    { host: 'example.test:5173' },
  ])('rejects untrusted requests without a provider call', async overrides => {
    expect(isTrustedDevProbeRequest(request(overrides))).toBe(false);
    const res = response();
    const probe = vi.fn(async () => ({ state: 'connected' }));
    await handleResponsesProbe(request(overrides), res.value, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(res.status()).toBe(403);
    expect(res.body()).toBe('{"error":"origin_not_allowed"}');
  });
});
