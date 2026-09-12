import './style.css';
import type { MatchSnapshot, ServerMessage, SpinView, UpgradeId } from '../shared/protocol';
import {
  advanceMatch,
  createMatch,
  getSnapshot,
  startMatch,
  UPGRADE_DEFINITIONS,
  PAYOUT,
  type GameEvent,
  type MatchState,
} from './domain/game';
import { LiveClient } from './client/live';
import { submitCpuUpgrade } from './client/cpu';
import { ReelScene } from './view/ReelScene';
import { GameAudio } from './view/GameAudio';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('missing_app');

app.innerHTML = `
<section class="shell">
  <header class="topbar">
    <h1>Slot-chan</h1>
    <div class="timer"><small>残り</small><b id="time">60</b><span>秒</span></div>
    <div class="status-cluster"><span id="modeBadge">未接続</span><button id="sound" aria-label="AI音声をミュート" aria-pressed="false" hidden>AI音声 ON</button><button id="effects" aria-label="効果音をミュート" aria-pressed="false">効果音 ON</button><button id="leave">退出</button></div>
  </header>
  <div class="scores">
    <div class="you"><span><i class="score-crest" aria-hidden="true">♛</i>あなた</span><strong id="ps">0</strong><span class="score-meter" aria-hidden="true"><i id="playerMeter"></i></span></div>
    <span class="duel-gap" id="scoreGap" role="status">互角の勝負</span>
    <div class="rival"><span><i class="score-crest" aria-hidden="true">♜</i>ライバル</span><strong id="rs">0</strong><span class="score-meter" aria-hidden="true"><i id="rivalMeter"></i></span></div>
  </div>
  <div class="arena">
    <section class="machine" aria-label="あなたのスロット">
      <div class="machine-title"><span>◆</span> Slot-chan <span>◆</span></div>
      <div class="event-cue" id="eventCue" role="status" hidden></div>
      <div class="reel-window"><div id="reels"></div></div>
      <div class="pay" id="pay" aria-live="polite"></div>
      <div class="last-spin" id="lastSpin">🍒　🔔　7</div>
      <div class="machine-trim"><span>中央の1ラインで判定</span><span id="upgradeProgress">改造チャンス 20秒・40秒</span></div>
    </section>
    <aside class="avatar">
      <div class="portrait"><div class="mock-face" id="mockFace"><small>YOUR CHALLENGER</small><div class="rival-crest" aria-hidden="true"><span>7</span></div><strong>CPU RIVAL</strong><span id="rivalMood">正々堂々、60秒。</span></div><video id="avatar" autoplay playsinline></video></div>
      <div class="speech"><p id="line">「60秒。私に勝てる？」</p><small id="heard"></small></div>
      <div class="mini"><span>ライバルのリール</span><strong id="rivalReels">🍒　🔔　7</strong></div>
      <div class="builds"><div><span>あなたの改造</span><strong id="playerBuild">未改造</strong></div><div><span>相手の改造</span><strong id="rivalBuild">未改造</strong></div></div>
      <div class="connection" id="connection">接続していません</div>
    </aside>
  </div>
  <div class="upgrade" id="upgrade" hidden>
    <div><b>リール改造を選べ！</b><span id="upgradeNo"></span><small id="upgradeRemain"></small><small id="upgradeChoice" aria-live="polite"></small></div>
    <button data-up="steady" aria-pressed="false"><strong>🍒 安定型</strong><small>${UPGRADE_DEFINITIONS.steady.description}</small><kbd>1</kbd></button>
    <button data-up="jackpot" aria-pressed="false"><strong>7 大勝負</strong><small>${UPGRADE_DEFINITIONS.jackpot.description}</small><kbd>2</kbd></button>
  </div>
  <footer>
    <div class="result" id="result" hidden><strong id="resultTitle"></strong><span id="resultScore"></span></div>
    <button id="start" disabled>60秒で勝ちきれ！</button>
    <p>自動で回る。20秒・40秒でリールを改造。多く稼いだ方が勝ち。</p>
    <p>3つそろうと 🍒 ${PAYOUT.cherry} ／ 🔔 ${PAYOUT.bell} ／ 7 ${PAYOUT.seven.toLocaleString()} 点</p>
  </footer>
</section>
<div class="gate" id="gate">
  <div class="gate-card">
    <div class="eyebrow">Slot-chan</div>
    <h2>リールを改造して<br><em>60秒で勝ちきれ。</em></h2>
    <p>自動で回るスロットを20秒・40秒に改造。相手より多く稼げば勝ち！ CPUも同じルールで勝負します。</p>
    <button id="practice" class="primary">CPUライバルと対戦</button>
    <small>無料・マイク不要。音声や映像がなくても遊べます。</small>
    <details class="voice-options"><summary>音声・映像もつける（任意）</summary>
      <p>マイク音声を外部AIサービスへ送信します。招待コードが必要です。終了後に接続を閉じ、会話本文は保存しません。</p>
      <label>招待コード<input id="invite" type="password" autocomplete="off" placeholder="Invite code"></label>
      <button id="liveConnect">音声・映像つきで対戦</button>
    </details>
    <small id="gateMessage" role="status">通常のCPU対戦では外部AIサービスに接続しません。</small>
  </div>
</div>
<div class="countdown" id="countdown" hidden>3</div>
`;

const q = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing_element:${selector}`);
  return element;
};

const scene = new ReelScene(q('#reels'));
const effects = new GameAudio();
const avatarVideo = q<HTMLVideoElement>('#avatar');
const startButton = q<HTMLButtonElement>('#start');
const gate = q<HTMLDivElement>('#gate');
const upgradePanel = q<HTMLDivElement>('#upgrade');
const resultPanel = q<HTMLDivElement>('#result');
const modeBadge = q<HTMLSpanElement>('#modeBadge');

let mode: 'idle' | 'practice' | 'live' = 'idle';
let practiceState: MatchState | null = null;
let practiceTimer: number | null = null;
let practiceStartedAt = 0;
let liveClient: LiveClient | null = null;
let liveSnapshot: MatchSnapshot | null = null;
let voiceReady = false;
let gameConnected = false;
let lastInviteCode = '';
let muted = false;
let activeOffer: { index: 0 | 1; closesAt: number } | null = null;
let assistantText = '';
let assistantResetTimer = 0;
let revision = 0;
let starting = false;
let effectsMuted = false;
let warnedTime = false;
let previousLeader: 'player' | 'rival' | null = null;
let cueTimer = 0;
const battleTimers = new Set<number>();

function later(action: () => void, delay: number): void {
  const current = revision;
  const timer = window.setTimeout(() => {
    battleTimers.delete(timer);
    if (current === revision) action();
  }, delay);
  battleTimers.add(timer);
}

function cancelBattle(): void {
  revision += 1;
  starting = false;
  stopPracticeTimer();
  battleTimers.forEach(clearTimeout);
  battleTimers.clear();
  effects.stop();
  scene.stop();
  clearTimeout(cueTimer);
  q('#eventCue').hidden = true;
  clearTimeout(assistantResetTimer);
  q<HTMLDivElement>('#countdown').hidden = true;
  hideUpgrade();
  practiceState = null;
  voiceReady = false;
  gameConnected = false;
  const previous = liveClient;
  liveClient = null;
  void previous?.disconnect();
}

function returnToGate(message: string): void {
  cancelBattle();
  effects.dispose();
  mode = 'idle';
  modeBadge.textContent = '未接続';
  modeBadge.className = '';
  q('#sound').hidden = true;
  gate.hidden = false;
  startButton.disabled = true;
  q<HTMLButtonElement>('#liveConnect').disabled = false;
  q('#gateMessage').textContent = message;
  q('#mockFace').hidden = false;
}

function glyphs(spin: SpinView): string {
  const glyph = { cherry: '🍒', bell: '🔔', seven: '7' } as const;
  return spin.symbols.map((symbol) => glyph[symbol]).join('　');
}

function renderSnapshot(snapshot: MatchSnapshot): void {
  q('#time').textContent = String(Math.max(0, Math.ceil(snapshot.remaining))).padStart(2, '0');
  q('#ps').textContent = snapshot.scores.player.toLocaleString();
  q('#rs').textContent = snapshot.scores.rival.toLocaleString();
  const total = snapshot.scores.player + snapshot.scores.rival;
  const gap = snapshot.scores.player - snapshot.scores.rival;
  q('#playerMeter').style.width = `${total ? snapshot.scores.player / total * 100 : 50}%`;
  q('#rivalMeter').style.width = `${total ? snapshot.scores.rival / total * 100 : 50}%`;
  const gapText = gap === 0 ? '互角の勝負' : `${Math.abs(gap).toLocaleString()}点 ${gap > 0 ? 'リード' : 'ビハインド'}`;
  if (q('#scoreGap').textContent !== gapText) q('#scoreGap').textContent = gapText;
  q('#scoreGap').dataset.leader = gap > 0 ? 'player' : gap < 0 ? 'rival' : 'draw';
  q('#mockFace').dataset.mood = gap > 0 ? 'behind' : gap < 0 ? 'ahead' : 'even';
  q('#rivalMood').textContent = snapshot.status === 'result' ? (gap > 0 ? '次こそ、負けない。' : gap < 0 ? 'もう一度、挑む？' : '決着は、次の勝負で。') : gap > 0 ? 'ここから、巻き返す。' : gap < 0 ? 'このまま、逃げきる。' : '正々堂々、60秒。';
  const buildLabel = (upgrades: UpgradeId[]) => upgrades.length ? upgrades.map(id => id === 'steady' ? '🍒 安定型' : '7 大勝負').join(' / ') : '未改造';
  q('#playerBuild').textContent = buildLabel(snapshot.upgrades.player);
  q('#rivalBuild').textContent = buildLabel(snapshot.upgrades.rival);
  q('#upgradeProgress').textContent = snapshot.status === 'playing' ? activeOffer ? '改造を選ぼう！' : snapshot.elapsed < 20 ? `改造まで ${Math.ceil(20 - snapshot.elapsed)}秒` : snapshot.elapsed < 40 ? `次の改造まで ${Math.ceil(40 - snapshot.elapsed)}秒` : '改造完了・ラストスパート' : snapshot.status === 'result' ? '対戦終了' : '改造チャンス 20秒・40秒';
  q('#time').parentElement!.classList.toggle('urgent', snapshot.status === 'playing' && snapshot.remaining <= 10);
  if (snapshot.status === 'playing') {
    const leader = snapshot.scores.player === snapshot.scores.rival ? null : snapshot.scores.player > snapshot.scores.rival ? 'player' : 'rival';
    if (leader && previousLeader && leader !== previousLeader) {
      announce(leader === 'player' ? '逆転！ あなたがリード' : 'ライバルが逆転！', 'lead');
    }
    if (leader) previousLeader = leader;
    if (!warnedTime && snapshot.remaining <= 10) {
      warnedTime = true;
      announce('残り10秒！ 最後まで勝負', 'warning');
    }
  }
  if (activeOffer) {
    const left = Math.max(0, activeOffer.closesAt - snapshot.elapsed);
    q('#upgradeRemain').textContent = `残り ${left.toFixed(1)}秒`;
    if (left <= 0) hideUpgrade();
  }
}

function announce(text: string, sound: 'lead' | 'warning' | 'jackpot'): void {
  clearTimeout(cueTimer);
  q('#eventCue').textContent = text;
  q('#eventCue').hidden = false;
  effects.play(sound);
  cueTimer = window.setTimeout(() => { q('#eventCue').hidden = true; }, 1800);
}

function showUpgrade(index: 0 | 1, closesAt: number): void {
  effects.play('choose');
  activeOffer = { index, closesAt };
  q('#upgradeNo').textContent = `${index + 1}/2`;
  q('#upgradeChoice').textContent = 'どちらか1つを選んで確定';
  upgradePanel.querySelectorAll('button').forEach((button) => {
    button.disabled = false;
    button.setAttribute('aria-pressed', 'false');
  });
  upgradePanel.hidden = false;
}

function hideUpgrade(): void {
  activeOffer = null;
  upgradePanel.hidden = true;
}

function showResult(snapshot: MatchSnapshot): void {
  effects.play('result');
  resultPanel.hidden = false;
  q('#resultTitle').textContent = snapshot.winner === 'player' ? '勝利！' : snapshot.winner === 'rival' ? '敗北' : '引き分け';
  q('#resultScore').textContent = `${snapshot.scores.player.toLocaleString()}  vs  ${snapshot.scores.rival.toLocaleString()}`;
  startButton.disabled = false;
  startButton.textContent = 'もう一度勝負';
}

function resetBattleUi(): void {
  effects.stop();
  warnedTime = false;
  previousLeader = null;
  clearTimeout(cueTimer);
  q('#eventCue').hidden = true;
  battleTimers.forEach(clearTimeout);
  battleTimers.clear();
  clearTimeout(assistantResetTimer);
  resultPanel.hidden = true;
  hideUpgrade();
  q('#pay').textContent = '';
  q('#lastSpin').textContent = '🍒　🔔　7';
  q('#rivalReels').textContent = '🍒　🔔　7';
  scene.show(['cherry', 'bell', 'seven']);
  q('#line').textContent = '「60秒。私に勝てる？」';
  q('#heard').textContent = '';
  assistantText = '';
}

function handleSpin(player: SpinView, rival: SpinView): void {
  scene.spin();
  effects.play('spin');
  later(() => {
    scene.show(player.symbols, player.payout);
    if (player.payout >= PAYOUT.seven) announce(`7揃い！ +${player.payout.toLocaleString()}`, 'jackpot');
    else if (player.payout > 0) effects.play('win');
  }, 320);
  q('#lastSpin').textContent = glyphs(player);
  q('#rivalReels').textContent = glyphs(rival);
  q('#pay').textContent = player.payout ? `+${player.payout.toLocaleString()}` : '';
  if (player.payout) later(() => (q('#pay').textContent = ''), 900);
}

function handlePracticeEvent(event: GameEvent): void {
  if (event.type === 'spin') handleSpin(event.player, event.rival);
  if (event.type === 'upgrade_open') {
    showUpgrade(event.offerIndex, event.closesAt);
    later(() => {
      if (!practiceState || practiceState.status !== 'playing') return;
      const pick: UpgradeId = practiceState.scores.rival < practiceState.scores.player ? 'jackpot' : Math.random() > 0.5 ? 'jackpot' : 'steady';
      submitCpuUpgrade(practiceState, 'rival', event.offerIndex, pick, practiceStartedAt);
    }, 700);
  }
  if (event.type === 'upgrade_applied') {
    hideUpgrade();
    q('#line').textContent = event.rival === 'jackpot' ? '「ここから大勝負で行く。」' : '「崩さず取りに行く。」';
  }
  if (event.type === 'leader_change') {
    if (event.leader === 'player') q('#line').textContent = '「ちょっと、そこで逆転する？」';
    if (event.leader === 'rival') q('#line').textContent = '「まだ勝ったとは言わないけど、いい感じ。」';
  }
  if (event.type === 'match_end') {
    stopPracticeTimer();
    showResult(event.snapshot);
    q('#line').textContent = event.snapshot.winner === 'player' ? '「……負けた。もう一回。」' : event.snapshot.winner === 'rival' ? '「私の勝ち。再戦する？」' : '「引き分け？ 次で決めよう。」';
  }
}

function startPractice(): void {
  stopPracticeTimer();
  resetBattleUi();
  practiceState = createMatch(Math.floor(Math.random() * 0xffff_ffff));
  startMatch(practiceState);
  practiceStartedAt = performance.now();
  renderSnapshot(getSnapshot(practiceState));
  startButton.disabled = true;
  startButton.textContent = '対戦中…';
  practiceTimer = window.setInterval(() => {
    if (!practiceState) return;
    const elapsed = (performance.now() - practiceStartedAt) / 1000;
    const events = advanceMatch(practiceState, elapsed);
    events.forEach(handlePracticeEvent);
    renderSnapshot(getSnapshot(practiceState));
  }, 100);
}

function stopPracticeTimer(): void {
  if (practiceTimer !== null) clearInterval(practiceTimer);
  practiceTimer = null;
}

function onLiveMessage(message: ServerMessage): void {
  if (message.type === 'voice_status') {
    q('#connection').textContent = message.status === 'ready' ? 'マイク接続中 / AI会話 READY' : message.status === 'connecting' ? 'AIキャラクター接続中…' : message.status === 'closed' ? '会話接続終了' : message.message ?? '会話エラー';
    voiceReady = message.status === 'ready';
    if (voiceReady) gameConnected = true;
    if (!voiceReady && gameConnected) {
      modeBadge.textContent = 'CPU対戦';
      modeBadge.className = 'practice';
      q('#mockFace').hidden = false;
      q('#sound').hidden = true;
      q('#heard').textContent = '';
      clearTimeout(assistantResetTimer);
      assistantText = '';
    }
    if (gameConnected && !starting && (!liveSnapshot || liveSnapshot.status === 'ready')) {
      startButton.disabled = false;
      startButton.textContent = '60秒で勝ちきれ！';
    }
    return;
  }
  if (message.type === 'snapshot') {
    liveSnapshot = message.snapshot;
    renderSnapshot(message.snapshot);
    return;
  }
  if (message.type === 'spin') {
    handleSpin(message.player, message.rival);
    return;
  }
  if (message.type === 'upgrade_offer') {
    showUpgrade(message.offerIndex, message.closesAtElapsed);
    return;
  }
  if (message.type === 'upgrade_applied') {
    hideUpgrade();
    return;
  }
  if (message.type === 'rival_line') {
    q('#line').textContent = `「${message.text}」`;
    return;
  }
  if (message.type === 'transcript') {
    if (message.role === 'user') {
      q('#heard').textContent = `あなた: ${message.delta}`;
      return;
    }
    window.clearTimeout(assistantResetTimer);
    assistantText = `${assistantText}${message.delta}`.slice(-120);
    q('#line').textContent = `「${assistantText}」`;
    assistantResetTimer = window.setTimeout(() => {
      assistantText = '';
      q('#line').textContent = '「次の一手、どうする？」';
    }, 2500);
    return;
  }
  if (message.type === 'match_ended') {
    liveSnapshot = message.snapshot;
    renderSnapshot(message.snapshot);
    showResult(message.snapshot);
    return;
  }
  if (message.type === 'error') {
    q('#connection').textContent = message.message;
    if (!message.recoverable) {
      if (!liveSnapshot || liveSnapshot.status === 'ready') prepareCpuMatch('音声・映像を利用できないため、CPU対戦を準備しました。');
      else returnToGate(`${message.message} 通常のCPU対戦を始められます。`);
    }
  }
}

async function connectLive(code: string): Promise<void> {
  cancelBattle();
  const current = revision;
  mode = 'live';
  q('#sound').hidden = false;
  startButton.disabled = true;
  voiceReady = false;
  liveSnapshot = null;
  resetBattleUi();
  q('#connection').textContent = 'マイク許可を確認中…';
  const client = new LiveClient(avatarVideo);
  liveClient = client;
  client.setMuted(muted);
  client.addEventListener('message', (event) => {
    if (liveClient === client) onLiveMessage((event as CustomEvent<ServerMessage>).detail);
  });
  client.addEventListener('disconnect', () => {
    if (liveClient !== client) return;
    voiceReady = false;
    if (liveSnapshot?.status === 'result') {
      q('#connection').textContent = '会話接続終了 / 再戦できます';
      liveClient = null;
      return;
    }
    if (!liveSnapshot || liveSnapshot.status === 'ready') prepareCpuMatch('音声・映像の接続が終了しました。CPU対戦を開始できます。');
    else returnToGate('対戦サーバーとの接続が終了しました。通常のCPU対戦を始められます。');
  });
  await client.connect(code);
  if (current !== revision || liveClient !== client) throw new Error('connection_cancelled');
  modeBadge.textContent = voiceReady ? 'LIVE AI' : 'CPU対戦';
  modeBadge.className = voiceReady ? 'live' : 'practice';
  q('#mockFace').hidden = voiceReady;
}

async function countdownThen(action: () => void): Promise<void> {
  const current = revision;
  const overlay = q<HTMLDivElement>('#countdown');
  overlay.hidden = false;
  for (const value of [3, 2, 1]) {
    overlay.textContent = String(value);
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    if (current !== revision) return;
  }
  overlay.textContent = 'GO!';
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  if (current !== revision) return;
  overlay.hidden = true;
  action();
}

async function startLiveOrRematch(): Promise<void> {
  if (!lastInviteCode) return;
  if (liveSnapshot?.status === 'playing') return;
  if (liveSnapshot?.status === 'result' || !liveClient) {
    startButton.disabled = true;
    q('#connection').textContent = '再戦のAIキャラクターを準備中…';
    await connectLive(lastInviteCode);
  }
  if (!gameConnected) throw new Error('game_not_ready');
  starting = true;
  resetBattleUi();
  startButton.disabled = true;
  startButton.textContent = '対戦中…';
  await countdownThen(() => liveClient?.send({ type: 'start' }));
}

q<HTMLButtonElement>('#liveConnect').onclick = async () => {
  const code = q<HTMLInputElement>('#invite').value.trim();
  if (!code) {
    q('#gateMessage').textContent = '招待コードを入力してください。';
    return;
  }
  q<HTMLButtonElement>('#liveConnect').disabled = true;
  q('#gateMessage').textContent = 'マイク許可 → AIキャラクター接続の順に準備します…';
  const attempt = revision + 1;
  try {
    await connectLive(code);
    lastInviteCode = code;
    gate.hidden = true;
    q<HTMLInputElement>('#invite').value = '';
  } catch {
    if (revision === attempt) prepareCpuMatch('音声・映像を利用できないため、CPU対戦を準備しました。開始ボタンで遊べます。');
  } finally {
    if (revision === attempt) q<HTMLButtonElement>('#liveConnect').disabled = false;
  }
};

function prepareCpuMatch(message = 'CPUライバル / マイク不要・外部API利用なし'): void {
  cancelBattle();
  resetBattleUi();
  renderSnapshot(getSnapshot(createMatch(1, 'preview')));
  mode = 'practice';
  q<HTMLButtonElement>('#liveConnect').disabled = false;
  gate.hidden = true;
  modeBadge.textContent = 'CPU対戦';
  modeBadge.className = 'practice';
  q('#sound').hidden = true;
  q('#connection').textContent = message;
  q('#line').textContent = '「60秒。私に勝てる？」';
  q('#mockFace').hidden = false;
  startButton.disabled = false;
  startButton.textContent = '60秒で勝ちきれ！';
}

q<HTMLButtonElement>('#practice').onclick = () => {
  prepareCpuMatch();
  startButton.click();
};

startButton.onclick = async () => {
  if (starting || startButton.disabled) return;
  void effects.unlock();
  starting = true;
  startButton.disabled = true;
  try {
    if (mode === 'practice' && practiceState?.status !== 'playing') await countdownThen(startPractice);
    if (mode === 'live') await startLiveOrRematch();
  } catch {
    if (mode === 'live') prepareCpuMatch('音声・映像つき対戦を開始できませんでした。CPU対戦を開始できます。');
  } finally {
    starting = false;
  }
};

q<HTMLButtonElement>('#leave').onclick = () => returnToGate('退出しました。マイクとAIの接続を終了しました。');

upgradePanel.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-up]');
  if (!button || button.disabled || !activeOffer) return;
  const upgradeId = button.dataset.up as UpgradeId;
  if (mode === 'practice' && practiceState && !submitCpuUpgrade(practiceState, 'player', activeOffer.index, upgradeId, practiceStartedAt)) return;
  if (mode === 'live') liveClient?.send({ type: 'upgrade', commandId: crypto.randomUUID(), upgradeId, offerIndex: activeOffer.index });
  effects.play('choose');
  upgradePanel.querySelectorAll('button').forEach((item) => {
    item.disabled = true;
    item.setAttribute('aria-pressed', String(item === button));
  });
  q('#upgradeChoice').textContent = `選択済み: ${upgradeId === 'steady' ? '🍒 安定型' : '7 大勝負'}`;
  button.blur();
});

addEventListener('keydown', (event) => {
  if (!activeOffer || (event.key !== '1' && event.key !== '2')) return;
  const id: UpgradeId = event.key === '1' ? 'steady' : 'jackpot';
  const button = upgradePanel.querySelector<HTMLButtonElement>(`button[data-up="${id}"]`);
  button?.click();
});

q<HTMLButtonElement>('#sound').onclick = () => {
  muted = !muted;
  liveClient?.setMuted(muted);
  q<HTMLButtonElement>('#sound').textContent = muted ? 'AI音声 OFF' : 'AI音声 ON';
  q('#sound').setAttribute('aria-label', muted ? 'AI音声のミュートを解除' : 'AI音声をミュート');
  q('#sound').setAttribute('aria-pressed', String(muted));
};

q<HTMLButtonElement>('#effects').onclick = () => {
  effectsMuted = !effectsMuted;
  effects.setMuted(effectsMuted);
  q('#effects').textContent = effectsMuted ? '効果音 OFF' : '効果音 ON';
  q('#effects').setAttribute('aria-label', effectsMuted ? '効果音のミュートを解除' : '効果音をミュート');
  q('#effects').setAttribute('aria-pressed', String(effectsMuted));
  if (!effectsMuted) void effects.unlock();
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && mode === 'live') liveClient?.send({ type: 'snapshot' });
});

addEventListener('beforeunload', () => {
  effects.dispose();
  stopPracticeTimer();
  void liveClient?.disconnect();
  scene.dispose();
});

renderSnapshot(getSnapshot(createMatch(1, 'preview')));
