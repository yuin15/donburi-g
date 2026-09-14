import { describe, expect, it } from 'vitest';
import { ProactiveConversationPacer } from './proactiveConversation';

describe('ProactiveConversationPacer', () => {
  const ready = { available: true, blocked: false };

  it('can disable silence invitations while keeping quiet gaps and settling user turns for offers', () => {
    const pacer = new ProactiveConversationPacer(() => 0, false);
    pacer.start(0);
    expect(pacer.canInitiate(2_999)).toBe(false);
    expect(pacer.canInitiate(3_000)).toBe(true);
    for (let now = 3_500; now <= 60_000; now += 500) expect(pacer.due(now, ready)).toBe(false);

    pacer.noteUserSpeech();
    pacer.noteUserTranscript('貸して');
    pacer.noteUserSpeechEnd(60_000);
    expect(pacer.hasPendingReply()).toBe(true);
    expect(pacer.due(60_500, ready)).toBe(false);
    expect(pacer.hasPendingReply()).toBe(false);
    expect(pacer.canInitiate(62_999)).toBe(false);
    expect(pacer.canInitiate(63_000)).toBe(true);
    pacer.noteAssistantSpeech(64_000);
    expect(pacer.canInitiate(66_999)).toBe(false);
    expect(pacer.canInitiate(67_000)).toBe(true);
  });

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

  it('holds unsolicited speech for three seconds after an audible line and resets from the latest PCM', () => {
    const pacer = new ProactiveConversationPacer(() => 0);
    pacer.start(0);
    expect(pacer.canInitiate(2_999)).toBe(false);
    expect(pacer.canInitiate(3_000)).toBe(true);
    pacer.markInitiatedSpeechSent(3_500);
    expect(pacer.canInitiate(6_499)).toBe(false);
    pacer.noteAssistantSpeech(4_000);
    pacer.noteAssistantSpeech(5_000);
    expect(pacer.canInitiate(7_999)).toBe(false);
    expect(pacer.canInitiate(8_000)).toBe(true);
  });

  it('restarts the quiet gap from a user turn ending', () => {
    const pacer = new ProactiveConversationPacer(() => 0);
    pacer.start(0);
    pacer.noteUserSpeech();
    pacer.noteUserSpeechEnd(10_000);
    expect(pacer.canInitiate(12_999)).toBe(false);
    expect(pacer.canInitiate(13_000)).toBe(true);
  });

  it('keeps the randomized quiet gap below five seconds and blocks an accepted append until audio times out', () => {
    const pacer = new ProactiveConversationPacer(() => 0.999);
    pacer.start(0);
    expect(pacer.canInitiate(4_997)).toBe(false);
    expect(pacer.canInitiate(4_998)).toBe(true);
    pacer.markInitiatedSpeechSent(4_998);
    expect(pacer.canInitiate(12_997)).toBe(false);
    expect(pacer.canInitiate(12_998)).toBe(true);
  });
});
