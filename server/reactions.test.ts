import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactionQueue } from './reactions';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('bounded live reaction candidates', () => {
  it('coalesces a same-round jackpot and leader change, choosing the higher priority once', () => {
    const speak = vi.fn(); const q = new ReactionQueue(speak);
    q.offer('leader:3', 'lead', 60, () => true);
    q.offer('jackpot:3', 'jackpot', 80, () => true);
    q.offer('jackpot:3', 'duplicate', 80, () => true);
    vi.advanceTimersByTime(1);
    expect(speak).toHaveBeenCalledExactlyOnceWith('jackpot'); q.close();
  });
  it('drops expired candidates and commentary whose score premise is no longer true', () => {
    const speak = vi.fn(); const q = new ReactionQueue(speak);
    q.offer('start', 'start', 10, () => true); vi.advanceTimersByTime(1);
    let leads = true;
    q.offer('leader', 'stale lead', 60, () => leads); leads = false;
    vi.advanceTimersByTime(3000);
    expect(speak).toHaveBeenCalledTimes(1);
    q.offer('late', 'expired', 80, () => true);
    vi.setSystemTime(Date.now() + 6001); vi.advanceTimersByTime(1);
    expect(speak).toHaveBeenCalledTimes(1); q.close();
  });
  it('reserves a final reaction, preempts pending commentary and never speaks after closing', () => {
    const speak = vi.fn(); const q = new ReactionQueue(speak);
    for (let i = 0; i < 8; i += 1) { q.offer('spin:' + i, 'playing', 20, () => true); vi.advanceTimersByTime(3100); }
    expect(speak).toHaveBeenCalledTimes(5);
    q.offer('result', 'result', 100, () => true, true);
    q.offer('old', 'old', 80, () => true); vi.advanceTimersByTime(1);
    expect(speak).toHaveBeenCalledTimes(6); expect(speak).toHaveBeenLastCalledWith('result');
    q.close(); q.offer('again', 'again', 100, () => true, true); vi.advanceTimersByTime(10000);
    expect(speak).toHaveBeenCalledTimes(6); expect(vi.getTimerCount()).toBe(0);
  });
  it('lets one essential transition through after ordinary reactions are exhausted, while still yielding to conversation', () => {
    const speak = vi.fn(); const q = new ReactionQueue(speak);
    for (let i = 0; i < 5; i += 1) { q.offer('spin:' + i, 'playing', 20, () => true); vi.advanceTimersByTime(3100); }
    q.conversationActivity();
    q.offer('zero-balance-chat', 'chat', 100, () => true, false, true, 5000);
    vi.advanceTimersByTime(3999);
    expect(speak).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(1);
    expect(speak).toHaveBeenLastCalledWith('chat'); q.close();
  });
  it('keeps queues from different sessions independent', () => {
    const a = vi.fn(), b = vi.fn(); const qa = new ReactionQueue(a), qb = new ReactionQueue(b);
    qa.offer('start', 'a', 10, () => true); qb.offer('start', 'b', 10, () => true);
    qa.close(); vi.advanceTimersByTime(1);
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledExactlyOnceWith('b'); qb.close();
  });
});
it('drops pending commentary and leaves room for a user reply before new game reactions', () => {
  const speak = vi.fn(), q = new ReactionQueue(speak);
  q.offer('old-jackpot', 'old', 80, () => true);
  q.conversationActivity();
  vi.advanceTimersByTime(100);
  q.offer('leader', 'distracting', 60, () => true);
  vi.advanceTimersByTime(3000);
  expect(speak).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1500);
  q.offer('new-jackpot', 'fresh', 80, () => true);
  vi.advanceTimersByTime(1);
  expect(speak).toHaveBeenCalledExactlyOnceWith('fresh');
  q.close();
});
