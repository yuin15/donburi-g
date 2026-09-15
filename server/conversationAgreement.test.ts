import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot, createMatch, startMatch } from '../src/domain/game';
import { ConversationAgreementCoordinator } from './conversationAgreement';

const request = vi.fn();
vi.stubGlobal('fetch', request);

function turn(id = 'match:turn:1') {
  const state = createMatch(1, 'match', 'manual'); startMatch(state);
  return { id, snapshot: getSnapshot(state), transcript: 'synthetic turn', conversation: 'P:synthetic turn', activeOffers: { mutual_bonus: 'offer-bonus', time_extension: 'offer-time' } };
}

afterEach(() => { request.mockReset(); });

describe('ConversationAgreementCoordinator', () => {
  it('returns all accepted actions from one structured Responses result and applies each server key once', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: '{"result":"accept","agreements":[{"action":"mutual_bonus","offerId":"offer-bonus"},{"action":"time_extension","offerId":"offer-time"}]}' }));
    const coordinator = new ConversationAgreementCoordinator();
    const outcome = await coordinator.resolve(turn());
    expect(outcome).toEqual({ state: 'accepted', id: 'match:turn:1', agreements: [{ action: 'mutual_bonus', offerId: 'offer-bonus' }, { action: 'time_extension', offerId: 'offer-time' }] });
    expect(JSON.parse(request.mock.calls[0][1].body).max_output_tokens).toBe(512);
    if (outcome.state !== 'accepted') return;
    const apply = vi.fn(() => true);
    expect(coordinator.applyOnce(outcome.id, outcome.agreements[0], apply)).toBe(true);
    expect(coordinator.applyOnce(outcome.id, outcome.agreements[0], apply)).toBe(false);
    expect(coordinator.applyOnce(outcome.id, outcome.agreements[1], apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('normalizes direct and offered duplicates to one action, preferring the verified offer', async () => {
    request.mockResolvedValueOnce(Response.json({ status: 'completed', output_text: '{"result":"accept","agreements":[{"action":"mutual_bonus","offerId":null},{"action":"mutual_bonus","offerId":"offer-bonus"}]}' }));
    request.mockResolvedValueOnce(Response.json({ status: 'completed', output_text: '{"state":"commit","agreements":[{"action":"time_extension","offerId":null},{"action":"time_extension","offerId":"offer-time"}],"offers":[]}' }));
    const coordinator = new ConversationAgreementCoordinator();

    await expect(coordinator.resolve(turn())).resolves.toEqual({
      state: 'accepted', id: 'match:turn:1', agreements: [{ action: 'mutual_bonus', offerId: 'offer-bonus' }],
    });
    await expect(coordinator.auditAssistantSpeech(turn().snapshot, 'synthetic promise', 'P:synthetic', turn().activeOffers)).resolves.toEqual({
      state: 'commit', agreements: [{ action: 'time_extension', offerId: 'offer-time' }],
    });
  });

  it('uses both turn/action and offer/action ledger keys for money and time', () => {
    const apply = vi.fn(() => true);
    const moneyDirectThenOffer = new ConversationAgreementCoordinator();
    expect(moneyDirectThenOffer.applyOnce('match:turn:1', { action: 'mutual_bonus', offerId: null }, apply)).toBe(true);
    expect(moneyDirectThenOffer.applyOnce('match:turn:1', { action: 'mutual_bonus', offerId: 'offer-bonus' }, apply)).toBe(false);
    expect(moneyDirectThenOffer.applyOnce('match:turn:2', { action: 'mutual_bonus', offerId: 'offer-bonus' }, apply)).toBe(false);

    const moneyOfferThenDirect = new ConversationAgreementCoordinator();
    expect(moneyOfferThenDirect.applyOnce('match:turn:1', { action: 'mutual_bonus', offerId: 'offer-bonus' }, apply)).toBe(true);
    expect(moneyOfferThenDirect.applyOnce('match:turn:1', { action: 'mutual_bonus', offerId: null }, apply)).toBe(false);

    const timeDirectThenOffer = new ConversationAgreementCoordinator();
    expect(timeDirectThenOffer.applyOnce('match:turn:1', { action: 'time_extension', offerId: null }, apply)).toBe(true);
    expect(timeDirectThenOffer.applyOnce('match:turn:1', { action: 'time_extension', offerId: 'offer-time' }, apply)).toBe(false);

    const timeOfferThenDirect = new ConversationAgreementCoordinator();
    expect(timeOfferThenDirect.applyOnce('match:turn:1', { action: 'time_extension', offerId: 'offer-time' }, apply)).toBe(true);
    expect(timeOfferThenDirect.applyOnce('match:turn:1', { action: 'time_extension', offerId: null }, apply)).toBe(false);

    const distinctDirectMoney = new ConversationAgreementCoordinator();
    expect(distinctDirectMoney.applyOnce('match:turn:1', { action: 'mutual_bonus', offerId: null }, apply)).toBe(true);
    expect(distinctDirectMoney.applyOnce('match:turn:2', { action: 'mutual_bonus', offerId: null }, apply)).toBe(true);

    const repeatedMoneyOffer = new ConversationAgreementCoordinator();
    expect(repeatedMoneyOffer.applyOnce('match:turn:1', { action: 'mutual_bonus', offerId: 'offer-bonus' }, apply)).toBe(true);
    expect(repeatedMoneyOffer.applyOnce('match:turn:2', { action: 'mutual_bonus', offerId: 'offer-bonus' }, apply)).toBe(false);
    expect(repeatedMoneyOffer.applyOnce('match:turn:2', { action: 'mutual_bonus', offerId: null }, apply)).toBe(false);
    expect(repeatedMoneyOffer.applyOnce('match:turn:3', { action: 'mutual_bonus', offerId: null }, apply)).toBe(true);

    const repeatedOffer = new ConversationAgreementCoordinator();
    expect(repeatedOffer.applyOnce('match:turn:1', { action: 'time_extension', offerId: 'offer-time' }, apply)).toBe(true);
    expect(repeatedOffer.applyOnce('match:turn:2', { action: 'time_extension', offerId: 'offer-time' }, apply)).toBe(false);
    expect(repeatedOffer.applyOnce('match:turn:2', { action: 'time_extension', offerId: null }, apply)).toBe(false);
    expect(repeatedOffer.applyOnce('match:turn:3', { action: 'time_extension', offerId: null }, apply)).toBe(true);
    expect(repeatedOffer.applyOnce('match:turn:4', { action: 'time_extension', offerId: null }, apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(11);
  });

  it('keeps provider failure distinct from a successful no-agreement result', async () => {
    request.mockResolvedValueOnce(Response.json({ status: 'failed' }));
    request.mockResolvedValueOnce(Response.json({ status: 'completed', output_text: '{"result":"none","agreements":[]}' }));
    const coordinator = new ConversationAgreementCoordinator();
    expect(await coordinator.resolve(turn('failure'))).toEqual({ state: 'unavailable', id: 'failure' });
    expect(await coordinator.resolve(turn('none'))).toEqual({ state: 'none', id: 'none' });
  });

  it('allows a delayed transcript revision to reclassify a prior none for the same turn', async () => {
    request.mockResolvedValueOnce(Response.json({ status: 'completed', output_text: '{"result":"none","agreements":[]}' }));
    request.mockResolvedValueOnce(Response.json({ status: 'completed', output_text: '{"result":"accept","agreements":[{"action":"mutual_bonus","offerId":"offer-bonus"}]}' }));
    const coordinator = new ConversationAgreementCoordinator();
    expect(await coordinator.resolve(turn('same-turn'))).toEqual({ state: 'none', id: 'same-turn' });
    await expect(coordinator.resolve({ ...turn('same-turn'), transcript: 'synthetic delayed affirmative' }))
      .resolves.toEqual({ state: 'accepted', id: 'same-turn', agreements: [{ action: 'mutual_bonus', offerId: 'offer-bonus' }] });
  });

  it('states zero-balance and contextual-affirmative rules in the classifier prompt', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: '{"result":"none","agreements":[]}' }));
    const coordinator = new ConversationAgreementCoordinator();
    await coordinator.resolve(turn());
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.max_output_tokens).toBe(512);
    expect(body.instructions).toContain('both balances are zero');
    expect(body.instructions).toContain('いいよ、任せて');
  });

  it('does not apply a repeated acknowledgement of the same server offer in a later VAD turn', async () => {
    request.mockImplementation(() => Promise.resolve(Response.json({ status: 'completed', output_text: '{"result":"accept","agreements":[{"action":"mutual_bonus","offerId":"offer-bonus"}]}' })));
    const coordinator = new ConversationAgreementCoordinator();
    const first = await coordinator.resolve(turn('match:turn:1'));
    const repeated = await coordinator.resolve(turn('match:turn:2'));
    if (first.state !== 'accepted' || repeated.state !== 'accepted') throw new Error('expected_acceptance');
    const apply = vi.fn(() => true);
    expect(coordinator.applyOnce(first.id, first.agreements[0], apply)).toBe(true);
    expect(coordinator.applyOnce(repeated.id, repeated.agreements[0], apply)).toBe(false);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('audits a normal acceptance as a commit instead of releasing it as safe', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: '{"state":"commit","agreements":[{"action":"mutual_bonus","offerId":"offer-bonus"}],"offers":[]}' }));
    const coordinator = new ConversationAgreementCoordinator();
    await expect(coordinator.auditAssistantSpeech(turn().snapshot, 'synthetic acceptance', 'P:synthetic request', turn().activeOffers)).resolves.toEqual({ state: 'commit', agreements: [{ action: 'mutual_bonus', offerId: 'offer-bonus' }] });
  });

  it('fails closed when an assistant audit cannot prove a safe or server-backed route', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: '{"state":"safe","agreements":[{"action":"time_extension","offerId":null}],"offers":[]}' }));
    const coordinator = new ConversationAgreementCoordinator();
    await expect(coordinator.auditAssistantSpeech(turn().snapshot, 'synthetic ambiguous promise', '', turn().activeOffers)).resolves.toEqual({ state: 'unavailable' });
  });

  it('keeps shared-bonus causal rules explicit in the normal-speech audit prompt', async () => {
    request.mockResolvedValue(Response.json({ status: 'completed', output_text: '{"state":"offer","agreements":[],"offers":["mutual_bonus"]}' }));
    const coordinator = new ConversationAgreementCoordinator();
    await expect(coordinator.auditAssistantSpeech(turn().snapshot, 'synthetic AI bonus request', 'P:synthetic chat', turn().activeOffers))
      .resolves.toEqual({ state: 'offer', actions: ['mutual_bonus'] });
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.instructions).toContain('captured causal player conversation');
    expect(JSON.parse(body.input).spokenAssistantSpeech.speaker).toBe('AI rival');
    expect(body.instructions).toContain('is commit with mutual_bonus and time_extension');
    expect(body.instructions).toContain('ALREADY been spoken');
  });
});
