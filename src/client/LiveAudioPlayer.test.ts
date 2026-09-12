import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveAudioPlayer } from './LiveAudioPlayer';

const sources: Array<{ buffer: { duration: number; samples: Float32Array } | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
const close = vi.fn(), resume = vi.fn();
let gain: { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
beforeEach(() => {
  sources.length = 0;
  close.mockReset().mockResolvedValue(undefined);
  resume.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('AudioContext', class {
    currentTime = 10;
    state = 'running';
    resume = resume;
    close = close;
    createGain() { return gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
    createBuffer(_channels: number, length: number, rate: number) {
      const samples = new Float32Array(length);
      return { samples, duration: length / rate, getChannelData: () => samples };
    }
    createBufferSource() {
      const source = { buffer: null, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), onended: null };
      sources.push(source);
      return source;
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

const silence = Buffer.alloc(4800).toString('base64');
it('decodes signed little-endian PCM, schedules contiguous audio, and clears old sources on interruption', async () => {
  const player = new LiveAudioPlayer();
  player.setMuted(true);
  await player.prepare();
  expect(gain.gain.value).toBe(0);
  player.setMuted(false);
  const samples = Buffer.alloc(4800);
  [0, 32767, -32768, -1].forEach((value, i) => samples.writeInt16LE(value, i * 2));
  player.play(samples.toString('base64'));
  player.play(silence);
  expect(Array.from(sources[0].buffer!.samples.slice(0, 4))).toEqual([0, 32767 / 32768, -1, -1 / 32768]);
  expect(sources[0].start.mock.calls[0][0]).toBeCloseTo(10.04);
  expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(10.14);
  player.interrupt();
  for (const source of sources) expect(source.stop).toHaveBeenCalledOnce();
  player.play(silence);
  expect(sources[2].start.mock.calls[0][0]).toBeCloseTo(10.04);
  await player.close();
  await player.close();
  player.play(silence);
  expect(sources).toHaveLength(3);
  expect(sources[2].stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('does not build an unbounded speech backlog when network frames arrive in a burst', async () => {
  const player = new LiveAudioPlayer();
  await player.prepare();
  for (let i = 0; i < 11; i++) player.play(silence);
  expect(sources.filter(source => source.stop.mock.calls.length)).toHaveLength(8);
  expect(sources[10].start.mock.calls[0][0]).toBeLessThan(10.75);
  await player.close();
  expect(sources.every(source => source.stop.mock.calls.length === 1)).toBe(true);
});
