import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GameAudio } from './GameAudio';

const contexts: Array<FakeContext> = [];
function fakeGain() {
  return { gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
}
function fakeOscillator() {
  return { type: 'sine', frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
}
class FakeContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => { this.state = 'closed'; });
  oscillators: Array<ReturnType<typeof fakeOscillator>> = [];
  gains: Array<ReturnType<typeof fakeGain>> = [];
  constructor() { contexts.push(this); }
  createGain() {
    const gain = fakeGain();
    this.gains.push(gain);
    return gain;
  }
  createOscillator() {
    const oscillator = fakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
}
beforeEach(() => { contexts.length = 0; vi.stubGlobal('AudioContext', FakeContext); });
afterEach(() => vi.unstubAllGlobals());

it('does not allocate audio until an explicit unlock', async () => {
  const audio = new GameAudio();
  audio.play('jackpot');
  expect(contexts).toHaveLength(0);
  await audio.unlock();
  audio.play('win');
  expect(contexts).toHaveLength(1);
  expect(contexts[0].oscillators.length).toBeGreaterThan(0);
  audio.dispose();
});

it('plays the BET switch click through the existing effects master', async () => {
  const audio = new GameAudio();
  audio.betClick();
  expect(contexts).toHaveLength(0);
  await audio.unlock();
  audio.betClick();
  expect(contexts[0].oscillators).toHaveLength(2);
  expect(contexts[0].oscillators.map(node => node.type)).toEqual(['triangle', 'square']);
  audio.setMuted(true);
  audio.betClick();
  expect(contexts[0].oscillators).toHaveLength(2);
  audio.dispose();
});

it('mutes and cancels scheduled cues, then retains mute across restart', async () => {
  const audio = new GameAudio();
  await audio.unlock();
  audio.play('jackpot');
  const nodes = [...contexts[0].oscillators];
  audio.setMuted(true);
  expect(contexts[0].gains[0].gain.value).toBe(0);
  for (const node of nodes) expect(node.stop).toHaveBeenCalledTimes(2);
  audio.play('spin');
  expect(contexts[0].oscillators).toHaveLength(nodes.length);
  audio.dispose();
  await audio.unlock();
  expect(contexts[1].gains[0].gain.value).toBe(0);
  audio.play('win');
  expect(contexts[1].oscillators).toHaveLength(0);
  audio.dispose();
});

it('releases the context and disconnects ended nodes when leaving a match', async () => {
  const audio = new GameAudio();
  await audio.unlock();
  audio.play('choose');
  const context = contexts[0];
  audio.dispose();
  context.oscillators.forEach(node => node.onended?.());
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(context.oscillators[0].disconnect).toHaveBeenCalled();
  expect(context.gains[1].disconnect).toHaveBeenCalled();
  audio.play('result');
  expect(context.oscillators).toHaveLength(1);
});
