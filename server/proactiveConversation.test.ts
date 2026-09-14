import { describe, expect, it } from 'vitest';
import { ProactiveConversationPacer } from './proactiveConversation';

describe('ProactiveConversationPacer', () => {
  const ready = { available: true, blocked: false };

  it('starts from silence, then waits for a reply before considering another invitation', () => {
    const pacer = new ProactiveConversationPacer(() => 0);
    pacer.start(0);
    expect(pacer.due(3_499, ready)).toBe(false);
    expect(pacer.due(3_500, ready)).toBe(true);
    pacer.markInvitationSent(3_500);
    expect(pacer.hasPendingReply()).toBe(true);
    expect(pacer.due(20_000, ready)).toBe(false);
  });

  it('backs off after silence or a short reply, while leaving blocked decisions alone', () => {
    const pacer = new ProactiveConversationPacer(() => 0);
    pacer.start(0);
    pacer.markInvitationSent(3_500);
    expect(pacer.due(13_500, ready)).toBe(false);
    expect(pacer.due(28_499, ready)).toBe(false);
    expect(pacer.due(28_500, ready)).toBe(true);
    pacer.markInvitationSent(28_500);
    pacer.noteUserSpeech();
    pacer.noteUserTranscript('うん');
    pacer.noteUserSpeechEnd(29_000);
    expect(pacer.due(29_499, ready)).toBe(false);
    expect(pacer.due(29_500, ready)).toBe(false);
    expect(pacer.due(49_999, { available: true, blocked: true })).toBe(false);
    expect(pacer.due(50_500, ready)).toBe(true);
  });

  it('does not count a rejected provider request as an unanswered question', () => {
    const pacer = new ProactiveConversationPacer(() => 0);
    pacer.start(0);
    expect(pacer.due(3_500, ready)).toBe(true);
    pacer.retryAfterRejectedRequest(3_500);
    expect(pacer.due(3_600, ready)).toBe(false);
    expect(pacer.due(4_500, ready)).toBe(true);
  });

  it('clears a pending reply when stopped at match end', () => {
    const pacer = new ProactiveConversationPacer(() => 0);
    pacer.start(0);
    pacer.markInvitationSent(3_500);
    pacer.stop();
    expect(pacer.hasPendingReply()).toBe(false);
    expect(pacer.due(99_000, ready)).toBe(false);
  });

  it('starts the reply wait after audible assistant output, not append acceptance', () => {
    const pacer = new ProactiveConversationPacer(() => 0);
    pacer.start(0);
    pacer.markInvitationSent(3_500);
    pacer.noteAssistantSpeech(12_000);
    expect(pacer.due(21_999, ready)).toBe(false);
    expect(pacer.due(22_000, ready)).toBe(false);
    expect(pacer.due(37_000, ready)).toBe(true);
  });

  it('re-evaluates a late long transcript instead of retaining the short-answer backoff', () => {
    const pacer = new ProactiveConversationPacer(() => 0);
    pacer.start(0);
    pacer.markInvitationSent(3_500);
    pacer.noteUserSpeech();
    pacer.noteUserTranscript('うん');
    pacer.noteUserSpeechEnd(4_000);
    expect(pacer.due(4_500, ready)).toBe(false);
    pacer.noteUserTranscript('、でもさっきのベルは惜しかったね', 4_500);
    expect(pacer.due(13_499, ready)).toBe(false);
    expect(pacer.due(13_500, ready)).toBe(true);
  });
});
