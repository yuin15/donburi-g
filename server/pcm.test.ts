import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarAudioBuffer } from './pcm';

const silence = Buffer.alloc(4800).toString('base64');
const tone = Buffer.alloc(4800, 1).toString('base64');
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('continuous PCM to avatar utterances', () => {
  it('does not stream idle silence, preserves the onset, and seals speech after a short quiet tail', () => {
    const send = vi.fn(), end = vi.fn();
    const audio = new AvatarAudioBuffer(send, end);
    for (let i = 0; i < 100; i++) audio.append(silence);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 3; i++) audio.append(tone);
    expect(send).toHaveBeenCalledTimes(1);
    const first = Buffer.from(send.mock.calls[0][0], 'base64');
    expect(first.length).toBe(19_200);
    expect(first.subarray(0, 4800).every(value => value === 0)).toBe(true);
    expect(first.subarray(4800).every(value => value === 1)).toBe(true);
    for (let i = 0; i < 3; i++) audio.append(silence);
    expect(end).toHaveBeenCalledOnce();
    for (let i = 0; i < 100; i++) audio.append(silence);
    expect(send).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards an interrupted partial packet and never appends it to the next reply', () => {
    const send = vi.fn(), end = vi.fn();
    const audio = new AvatarAudioBuffer(send, end);
    audio.append(tone);
    audio.reset();
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    const reply = Buffer.alloc(4800, 2).toString('base64');
    audio.append(reply);
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledExactlyOnceWith(reply);
    expect(end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
