import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDevelopmentLoopbackOrigins, env, assertLiveConfiguration } from './env';
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
  it('accepts demo configuration without a database account', () => {
    const previous = { openaiKey: env.openaiKey, liveAvatarKey: env.liveAvatarKey };
    Object.assign(env, { openaiKey: 'test-provider-key', liveAvatarKey: 'test-avatar-key' });
    try { expect(assertLiveConfiguration).not.toThrow(); }
    finally { Object.assign(env, previous); }
  });
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
  it('adds only Vite loopback aliases for its actual port without changing normal origins', () => {
    const configuredOrigins = [...env.allowedOrigins];
    addDevelopmentLoopbackOrigins('127.0.0.1', 5176);
    expect(isAllowedOrigin('http://127.0.0.1:5176', '127.0.0.1:5176')).toBe(true);
    expect(isAllowedOrigin('http://localhost:5176', 'localhost:5176')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173', '127.0.0.1:5173')).toBe(false);
    expect(isAllowedOrigin('http://192.168.1.20:5176', '192.168.1.20:5176')).toBe(false);
    expect(isAllowedOrigin('http://localhost:5177', 'localhost:5177')).toBe(false);
    const ticket = issueTicket('test-invite', 'http://127.0.0.1:5176');
    expect(verifyTicket(ticket, 'http://127.0.0.1:5176').origin).toBe('http://127.0.0.1:5176');
    expect(env.allowedOrigins).toEqual(configuredOrigins);
  });
  it('does not add non-loopback listen addresses', () => {
    addDevelopmentLoopbackOrigins('0.0.0.0', 5178);
    addDevelopmentLoopbackOrigins('192.168.1.20', 5178);
    expect(isAllowedOrigin('http://127.0.0.1:5178', '127.0.0.1:5178')).toBe(false);
    expect(isAllowedOrigin('http://localhost:5178', 'localhost:5178')).toBe(false);
  });
  it('expires a ticket exactly at the 60-second boundary', () => {
    const ticket = issueTicket('test-invite', 'https://game.example');
    vi.advanceTimersByTime(59_999);
    expect(verifyTicket(ticket, 'https://game.example').sid).toBeTruthy();
    vi.advanceTimersByTime(1);
    expect(() => verifyTicket(ticket, 'https://game.example')).toThrow('expired_ticket');
  });
});
it('signs a voice-only mode that needs no avatar credential', () => {
  const previous = { openaiKey: env.openaiKey, liveAvatarKey: env.liveAvatarKey };
  Object.assign(env, { openaiKey: 'test-provider-key', liveAvatarKey: '' });
  try {
    expect(() => assertLiveConfiguration('audio')).not.toThrow();
    expect(() => assertLiveConfiguration('avatar')).toThrow('LIVEAVATAR_API_KEY');
    const ticket = issueTicket('test-invite', 'https://game.example', 'audio');
    expect(verifyTicket(ticket, 'https://game.example').voiceMode).toBe('audio');
  } finally { Object.assign(env, previous); }
});
