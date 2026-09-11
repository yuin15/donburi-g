import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, assertLiveConfiguration } from './env';
import { issueTicket, isAllowedOrigin, verifyTicket } from './auth';

vi.mock('./env', async (original) => {
  const actual = await original<typeof import('./env')>();
  Object.assign(actual.env, {
    signingKey: 'test-only-signing-material-for-unit-tests', inviteCode: 'test-invite',
    allowedOrigins: ['https://game.example'], vercelUrl: '',
  });
  return actual;
});
beforeEach(() => { vi.useFakeTimers(); env.liveEnabled = true; });
afterEach(() => { vi.useRealTimers(); });

describe('live access control', () => {
  it('rejects new and already-issued tickets when live mode is disabled', () => {
    const ticket = issueTicket('test-invite', 'https://game.example');
    env.liveEnabled = false;
    expect(() => issueTicket('test-invite', 'https://game.example')).toThrow('live_mode_disabled');
    expect(() => verifyTicket(ticket, 'https://game.example')).toThrow('live_mode_disabled');
    expect(assertLiveConfiguration).toThrow('live_mode_disabled');
  });
  it('rejects wrong invite codes, altered tickets and different origins', () => {
    expect(() => issueTicket('wrong', 'https://game.example')).toThrow('invalid_invite_code');
    const ticket = issueTicket('test-invite', 'https://game.example');
    expect(() => verifyTicket(ticket + 'x', 'https://game.example')).toThrow('invalid_ticket_signature');
    expect(() => verifyTicket(ticket, 'https://elsewhere.example')).toThrow('ticket_origin_mismatch');
    expect(isAllowedOrigin(undefined, 'game.example')).toBe(false);
    expect(isAllowedOrigin('https://elsewhere.example', 'game.example')).toBe(false);
  });
  it('expires a ticket exactly at the 60-second boundary', () => {
    const ticket = issueTicket('test-invite', 'https://game.example');
    vi.advanceTimersByTime(59_999);
    expect(verifyTicket(ticket, 'https://game.example').sid).toBeTruthy();
    vi.advanceTimersByTime(1);
    expect(() => verifyTicket(ticket, 'https://game.example')).toThrow('expired_ticket');
  });
});
