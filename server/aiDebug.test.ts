import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAiDebugStatus, probeResponses } from './aiDebug';

afterEach(() => vi.unstubAllGlobals());

describe('development AI debug status', () => {
  it.each([
    [{ liveEnabled: false, openaiKey: '', liveAvatarKey: '', signingKey: '', inviteCode: '' }, { gptLive: false, responses: false, liveAvatar: false, liveKit: false }],
    [{ liveEnabled: true, openaiKey: 'openai-secret', liveAvatarKey: '', signingKey: 'signing-secret', inviteCode: 'invite-secret' }, { gptLive: true, responses: true, liveAvatar: false, liveKit: false }],
    [{ liveEnabled: true, openaiKey: 'openai-secret', liveAvatarKey: 'avatar-secret', signingKey: 'signing-secret', inviteCode: 'invite-secret' }, { gptLive: true, responses: true, liveAvatar: true, liveKit: true }],
  ] as const)('reports configuration booleans only', (source, configured) => {
    const status = getAiDebugStatus(source);
    expect(status.configured).toEqual(configured);
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(JSON.stringify(status)).not.toContain('invite');
  });

  it('does not contact Responses without a configured key', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(probeResponses({ openaiKey: '', rivalModel: 'unused' })).resolves.toEqual({ state: 'not_configured' });
    expect(request).not.toHaveBeenCalled();
  });

  it('uses a short, non-stored probe and never returns a provider response', async () => {
    const request = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response('{"unsafe":"provider response"}', { status: 200 }));
    vi.stubGlobal('fetch', request);
    const result = await probeResponses({ openaiKey: 'test-secret', rivalModel: 'probe-model' });
    expect(result).toEqual({ state: 'connected' });
    const options = request.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    if (!options) throw new Error('missing_probe_options');
    expect(JSON.parse(String(options.body))).toEqual(expect.objectContaining({ input: 'ping', store: false, max_output_tokens: 16 }));
    expect(JSON.stringify(result)).not.toContain('provider response');
  });
});
