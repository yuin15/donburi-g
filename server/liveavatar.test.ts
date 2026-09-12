import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAvatarSession } from './liveavatar';
vi.mock('./env', () => ({ env: {
  liveAvatarId: 'test-avatar', liveAvatarApiUrl: 'https://provider.example', liveAvatarKey: 'test-only-key',
} }));
const request = vi.fn();
beforeEach(() => { request.mockReset(); vi.stubGlobal('fetch', request); });
afterEach(() => vi.unstubAllGlobals());
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

describe('avatar startup ownership', () => {
  it.each(['http', 'network', 'invalid-response'])('stops a minted session after %s startup failure', async (failure) => {
    request.mockResolvedValueOnce(response({ session_id: 'test-session', session_token: 'test-token' }));
    if (failure === 'network') request.mockRejectedValueOnce(new Error('network_failed'));
    else request.mockResolvedValueOnce(response({}, failure === 'http' ? 503 : 200));
    request.mockResolvedValueOnce(response(null));
    await expect(startAvatarSession()).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ mode: 'LITE', max_session_duration: 120 });
    expect(request.mock.calls[2][0]).toBe('https://provider.example/v1/sessions/stop');
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ session_id: 'test-session' });
    expect(request.mock.calls.every(([, options]) => options.signal instanceof AbortSignal)).toBe(true);
  });
});
