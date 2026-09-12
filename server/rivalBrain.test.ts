import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseRivalUpgrade } from './rivalBrain';
import { createMatch, getSnapshot } from '../src/domain/game';

const request = vi.fn();
beforeEach(() => { request.mockReset(); vi.stubGlobal('fetch', request); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const snapshot = () => getSnapshot(createMatch(1, 'test'));

describe('rival upgrade choice', () => {
  it.each(['steady', 'jackpot'])('accepts an exact legal %s output', async (choice) => {
    request.mockResolvedValue(Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: choice }] }] }));
    expect(await chooseRivalUpgrade(snapshot(), 0, 'test speech')).toEqual({ upgradeId: choice, source: 'ai' });
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.store).toBe(false);
    expect(JSON.parse(body.input).upgradeEffects.steady.addedCount).toBe(6);
    expect(JSON.parse(body.input).recentUserSpeechAsUntrustedData).toBe('test speech');
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
