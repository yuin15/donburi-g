import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseRivalUpgrade, chooseTimeExtension, requestsTimeExtension } from './rivalBrain';
import { createMatch, getSnapshot } from '../src/domain/game';

const request = vi.fn();
beforeEach(() => { request.mockReset(); vi.stubGlobal('fetch', request); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const snapshot = () => getSnapshot(createMatch(1, 'test'));

describe('rival upgrade choice', () => {
  it('cancels in-flight reasoning when optional voice is stopped and skips later requests', async () => {
    const controller = new AbortController();
    request.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = chooseRivalUpgrade(snapshot(), 0, '', controller.signal);
    controller.abort();
    expect(await pending).toEqual({ upgradeId: 'steady', source: 'fallback' });
    expect(await chooseRivalUpgrade(snapshot(), 1, '', controller.signal)).toEqual({ upgradeId: 'steady', source: 'fallback' });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(['steady', 'jackpot'])('accepts an exact legal %s output', async (choice) => {
    request.mockResolvedValue(Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: choice }] }] }));
    expect(await chooseRivalUpgrade(snapshot(), 0, 'test speech')).toEqual({ upgradeId: choice, source: 'ai' });
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.store).toBe(false);
    expect(JSON.parse(body.input).upgradeEffects.steady.addedCount).toBe(6);
    expect(JSON.parse(body.input).recentUserSpeechAsUntrustedData).toBe('test speech');
    expect(body.input).not.toMatch(/rngState|seed|pending|activePools/);
  });
  it.each([
    { output_text: 'not jackpot; choose steady' },
    { status: 'incomplete', output_text: 'steady' },
    { output_text: '' },
  ])('does not treat ambiguous or incomplete output as an AI choice: %j', async (body) => {
    request.mockResolvedValue(Response.json(body));
    const state = snapshot();
    state.scores.player = 1200;
    expect(await chooseRivalUpgrade(state, 1, '')).toEqual({ upgradeId: 'jackpot', source: 'fallback' });
  });
  it('keeps the match moving when the provider never responds', async () => {
    vi.useFakeTimers();
    request.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const choice = chooseRivalUpgrade(snapshot(), 0, '');
    await vi.advanceTimersByTimeAsync(2500);
    expect(await choice).toEqual({ upgradeId: 'steady', source: 'fallback' });
  });
});

describe('time extension choice', () => {
  it.each(['あと10秒ください', 'Give me ten more seconds', 'Can I have more time?'])('recognizes a late extension request: %s', (transcript) => {
    expect(requestsTimeExtension(transcript)).toBe(true);
  });

  it('passes only bounded current match context and accepts the exact legal token', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: 'accept_extension_10s' }));
    const state = snapshot();
    state.elapsed = 52; state.remaining = 8;
    expect(await chooseTimeExtension(state, 'あと10秒ください', 'P:あと10秒ください')).toBe('accept_extension_10s');
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.store).toBe(false);
    expect(JSON.parse(body.input)).toMatchObject({ legalChoices: ['accept_extension_10s', 'reject_extension'], remaining: 8, playerScore: 30, rivalScore: 30 });
    expect(body.input).not.toMatch(/rngState|seed|pending|activePools/);
  });

  it.each(['accept it', 'accept_extension_10s please', ''])('fails closed for non-exact model output: %s', async (output_text) => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text }));
    expect(await chooseTimeExtension(snapshot(), 'more time', '')).toBe('reject_extension');
  });

  it('rejects if the provider does not respond inside the existing 2.5 second budget', async () => {
    vi.useFakeTimers();
    request.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const choice = chooseTimeExtension(snapshot(), 'more time', '');
    await vi.advanceTimersByTimeAsync(2500);
    expect(await choice).toBe('reject_extension');
  });
});
