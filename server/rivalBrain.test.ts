import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptsImmediateLoanOffer, acceptsLoanOffer, acceptsTimeExtensionOffer, chooseLoanDecision, chooseRivalUpgrade, chooseTimeExtension, offersLoanToRival, rejectsLoanOffer, rejectsTimeExtensionOffer, requestsDirectLoan, requestsLoan, requestsTimeExtension } from './rivalBrain';
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
  it.each(['延長して', '10秒ちょうだい', 'あと十秒だけください', '十秒だけ延長して', '10秒伸ばして', 'もっと時間伸ばして！', 'もう少し時間ちょうだい', 'あとちょっとだけお願い', '時間増やせる？', '延長できる？', 'あと１０秒ください', 'あとじゅう秒ください', 'Give me ten more seconds. I can still beat you!', 'Scared? Give me ten more seconds and prove it.'])('recognizes a completed extension request: %s', (transcript) => {
    expect(requestsTimeExtension(transcript)).toBe(true);
  });

  it.each(['あと10秒で終わるね', '時間延長はいらない', '延長しないで', '延長してほしくない', '延長して欲しくない', '延長してほしくありません', '延長して欲しくありません', 'お願い', "I don't need more time."])('does not mistake a status or a negated request for an extension: %s', (transcript) => {
    expect(requestsTimeExtension(transcript)).toBe(false);
  });

  it.each(['うん', 'お願い', '伸ばして', 'YES', 'Sure!'])('recognizes an explicit reply to the rival offer: %s', transcript => {
    expect(acceptsTimeExtensionOffer(transcript)).toBe(true);
  });

  it.each(['延長はいらない', '時間伸ばさないで', 'no'])('does not accept a negative reply to the rival offer: %s', transcript => {
    expect(acceptsTimeExtensionOffer(transcript)).toBe(false);
    expect(rejectsTimeExtensionOffer(transcript)).toBe(true);
  });

  it('does not accept a time observation as a reply to the rival offer', () => {
    expect(acceptsTimeExtensionOffer('もう時間ないね')).toBe(false);
    expect(rejectsTimeExtensionOffer('もう時間ないね')).toBe(false);
  });

  it('passes only bounded current match context and accepts the exact legal token', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: 'accept_extension_10s' }));
    const state = snapshot();
    state.elapsed = 52; state.remaining = 8;
    expect(await chooseTimeExtension(state, 'あと10秒ください', 'P:あと10秒ください')).toBe('accept_extension_10s');
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.store).toBe(false);
    expect(JSON.parse(body.input)).toMatchObject({ legalChoices: ['accept_extension_10s', 'reject_extension', 'no_request'], remaining: 8, playerScore: 30, rivalScore: 30, rivalExtensionOfferActive: false });
    expect(body.input).not.toMatch(/rngState|seed|pending|activePools/);
  });

  it.each(['accept it', 'accept_extension_10s please', ''])('fails closed for non-exact model output: %s', async (output_text) => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text }));
    expect(await chooseTimeExtension(snapshot(), 'more time', '')).toBe('no_request');
  });

  it('passes an active rival offer separately from untrusted conversation text', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: 'accept_extension_10s' }));
    expect(await chooseTimeExtension(snapshot(), 'うん', 'P:うん', undefined, true)).toBe('accept_extension_10s');
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(JSON.parse(body.input)).toMatchObject({ rivalExtensionOfferActive: true });
  });

  it('rejects if the provider does not respond inside the existing 2.5 second budget', async () => {
    vi.useFakeTimers();
    request.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const choice = chooseTimeExtension(snapshot(), 'more time', '');
    await vi.advanceTimersByTimeAsync(2500);
    expect(await choice).toBe('no_request');
  });
});

describe('loan choice', () => {
  it.each(['少し貸して', 'もう一回だけ勝負させて', 'If you are confident, lend me money.', 'Can I borrow some cash?', 'Come on, just give me enough for one more shot.'])('routes a natural borrower request without approving it: %s', transcript => {
    expect(requestsLoan(transcript)).toBe(true);
  });

  it.each(['うん', '延長して', '今どっちが上？', 'お金貸してほしくない', 'お金貸して欲しくない', 'お金貸してほしくありません', 'お金貸して欲しくありません', 'お金を借りたくない', 'お金を借りたくありません', 'お金を借りたくはない', 'お金を借りない', 'お金を借りません', 'お金を借りる必要ない', 'お金を借りる必要ありません', 'お金を借りる必要はありません', 'お金を借りる必要がない', 'お金を借りるつもりはありません', 'お金を借りる気はない', "I can't borrow $5", "I don't want to borrow cash"])('does not route an unrelated or negated response as a borrower request: %s', transcript => {
    expect(requestsLoan(transcript)).toBe(false);
  });

  it.each(['お金を貸してほしい', 'お金を貸してくれない？', 'お金を借りられない？', '貸して', '5ドル貸して', 'Can you lend me $5?', 'Can I borrow $5?', 'Could I borrow some cash?'])('recognizes only a clear direct borrower request: %s', transcript => {
    expect(requestsDirectLoan(transcript)).toBe(true);
  });

  it.each(['お金貸してほしくない', 'お金貸して欲しくない', 'お金貸してほしくありません', 'お金貸して欲しくありません', 'お金を借りたくない', 'お金を借りたくありません', 'お金を借りたくはない', 'お金を借りない', 'お金を借りません', 'お金を借りる必要ない', 'お金を借りる必要ありません', 'お金を借りる必要はありません', 'お金を借りる必要がない', 'お金を借りるつもりはありません', 'お金を借りる気はない', '借りたくない', '借りない', 'お金はいらない', 'お金', 'もう一回勝負させて', "I can't borrow $5", "I don't want to borrow cash"])('does not directly route a negated, vague, or indirect loan request: %s', transcript => {
    expect(requestsDirectLoan(transcript)).toBe(false);
  });

  it.each(['Sure!', 'はい', 'いいですよ', 'okay', "Okay, I'll lend you some.", 'うん、5ドル貸してあげるよ'])('accepts a clear rival-loan reply: %s', transcript => {
    expect(acceptsLoanOffer(transcript)).toBe(true);
  });

  it.each(['no', 'いや', 'I guess so', 'yes, the timer is short', ''])('does not mistake negative, vague, or unrelated speech for approval: %s', transcript => {
    expect(acceptsLoanOffer(transcript)).toBe(false);
  });

  it.each(['いいよ', 'いいですよ', 'うん', 'はい', 'もちろん', '了解', 'Sure!', 'Okay, I\'ll lend you some.', 'うん、5ドル貸してあげるよ'])('accepts only an immediate clear rival-loan reply: %s', transcript => {
    expect(acceptsImmediateLoanOffer(transcript)).toBe(true);
  });

  it.each(['いいよ', 'いいですよ'])('waits for speech completion before accepting a Japanese affirmative ending in a comma: %s', affirmative => {
    expect(acceptsImmediateLoanOffer(`${affirmative}、`)).toBe(false);
    expect(acceptsImmediateLoanOffer(`${affirmative}、`, true)).toBe(true);
    expect(acceptsImmediateLoanOffer(`${affirmative}、でも無理`, true)).toBe(false);
  });

  it.each(['いや', '貸して', '貸してくれない？', 'いいよ、でも無理', 'いいですよ、でも無理', 'Sure,', 'I guess so', 'yes, the timer is short'])('does not immediately accept a negative, request, or partial reply: %s', transcript => {
    expect(acceptsImmediateLoanOffer(transcript)).toBe(false);
  });

  it.each(['no', 'いいえ'])('recognizes a short direct refusal: %s', transcript => {
    expect(rejectsLoanOffer(transcript)).toBe(true);
  });

  it.each(['貸す', '貸すよ', '貸しますよ', 'お金を貸すよ', 'お金を貸します', '5ドル貸してあげる', '金を貸してやる', "I'll lend you $5", 'I will loan you some cash'])('recognizes a clear voluntary player loan: %s', transcript => {
    expect(offersLoanToRival(transcript)).toBe(true);
  });

  it.each(['貸さない', 'お金を貸すつもりはない', 'お金を貸すつもりはありません', '貸してあげるつもりはない', '貸してあげるつもりはありません', 'お金を貸すのは無理', 'お金を貸すのはやめる', 'お金を貸すのをやめる', 'お金を貸すのをやめた', '貸すのをやめました', 'お金を貸そうか？', '貸して', 'お金を貸して', 'お金の話をしよう', "I won't lend you money", 'yes'])('does not mistake a refusal, reverse request, vague speech, or question for a player loan: %s', transcript => {
    expect(offersLoanToRival(transcript)).toBe(false);
  });

  it('sends only bounded current context and accepts an exact legal result', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: 'accept_loan' }));
    const state = snapshot();
    state.scores = state.balances = { player: 0, rival: 10 };
    expect(await chooseLoanDecision(state, 'rival_to_player', 'Please lend me enough for one more spin.', 'P:Please lend me enough for one more spin.')).toBe('accept_loan');
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.store).toBe(false);
    expect(JSON.parse(body.input)).toMatchObject({ legalChoices: ['accept_loan', 'reject_loan', 'no_request'], direction: 'rival_to_player', fixedAmount: 5, playerScore: 0, rivalScore: 10, rivalLoanOfferActive: false });
    expect(body.input).not.toMatch(/rngState|seed|pending|activePools/);
  });

  it.each(['accept it', 'accept_loan please', ''])('fails closed for non-exact model output: %s', async output_text => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text }));
    expect(await chooseLoanDecision(snapshot(), 'player_to_rival', 'Sure!', '', undefined, true)).toBe('no_request');
  });
});
