import './style.css';
import type { MatchSnapshot, ServerMessage, SpinView, UpgradeId } from '../shared/protocol';
import {
  advanceMatch,
  createMatch,
  getSnapshot,
  startMatch,
  submitUpgrade,
  type GameEvent,
  type MatchState,
} from './domain/game';
import { LiveClient } from './client/live';
import { ReelScene } from './view/ReelScene';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('missing_app');

app.innerHTML = `
<section class="shell">
  <header class="topbar">
    <h1>REEL FORGE</h1>
    <div class="timer"><small>残り</small><b id="time">60</b><span>秒</span></div>
    <div class="status-cluster"><span id="modeBadge">未接続</span><button id="sound" aria-label="音声をミュート">音声 ON</button></div>
  </header>
  <div class="scores">
    <div class="you"><span>あなた</span><strong id="ps">0</strong></div>
    <div class="rival"><span>ライバル</span><strong id="rs">0</strong></div>
  </div>
  <div class="arena">
    <section class="machine" aria-label="あなたのスロット">
      <div class="machine-title">REEL FORGE</div>
      <div id="reels"></div>
      <div class="pay" id="pay" aria-live="polite"></div>
      <div class="last-spin" id="lastSpin">🍒　🔔　7</div>
    </section>
    <aside class="avatar">
      <div class="portrait"><div class="mock-face" id="mockFace">AI<small>RIVAL</small></div><video id="avatar" autoplay playsinline></video></div>
      <div class="speech"><p id="line">「60秒。私に勝てる？」</p><small id="heard"></small></div>
      <div class="mini"><span>ライバルのリール</span><strong id="rivalReels">🍒　🔔　7</strong></div>
      <div class="connection" id="connection">接続していません</div>
    </aside>
  </div>
  <div class="upgrade" id="upgrade" hidden>
    <div><b>リール改造を選べ！</b><span id="upgradeNo"></span><small id="upgradeRemain"></small></div>
    <button data-up="steady"><strong>🍒 安定型</strong><small>チェリーを2枚追加</small><kbd>1</kbd></button>
    <button data-up="jackpot"><strong>7 大勝負</strong><small>7を2枚追加</small><kbd>2</kbd></button>
  </div>
  <div class="result" id="result" hidden><strong id="resultTitle"></strong><span id="resultScore"></span></div>
  <footer>
    <button id="start" disabled>60秒で勝ちきれ！</button>
    <p>自動で回る。20秒・40秒でリールを改造。多く稼いだ方が勝ち。</p>
  </footer>
</section>
<div class="gate" id="gate">
  <div class="gate-card">
    <div class="eyebrow">REEL FORGE / MVP</div>
    <h2>しゃべるライバルに<br><em>60秒で勝ちきれ。</em></h2>
    <p>ライブ対戦ではマイク音声をAIサービスへ送信します。試合終了後に接続を閉じ、会話本文はこのMVPでは保存しません。</p>
    <label>招待コード<input id="invite" type="password" autocomplete="off" placeholder="Invite code"></label>
    <button id="liveConnect" class="primary">AIライバルと対戦</button>
    <button id="practice">APIを使わず練習</button>
    <small id="gateMessage">マイクは「AIライバルと対戦」を押した後にだけ使用します。</small>
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
let lastInviteCode = '';
let muted = false;
let activeOffer: { index: 0 | 1; closesAt: number } | null = null;
let assistantText = '';
let assistantResetTimer = 0;

function glyphs(spin: SpinView): string {
  const glyph = { cherry: '🍒', bell: '🔔', seven: '7' } as const;
  return spin.symbols.map((symbol) => glyph[symbol]).join('　');
}

function renderSnapshot(snapshot: MatchSnapshot): void {
  q('#time').textContent = String(Math.max(0, Math.ceil(snapshot.remaining))).padStart(2, '0');
  q('#ps').textContent = snapshot.scores.player.toLocaleString();
  q('#rs').textContent = snapshot.scores.rival.toLocaleString();
  if (activeOffer) {
    const left = Math.max(0, activeOffer.closesAt - snapshot.elapsed);
    q('#upgradeRemain').textContent = `残り ${left.toFixed(1)}秒`;
    if (left <= 0) hideUpgrade();
  }
}

function showUpgrade(index: 0 | 1, closesAt: number): void {
  activeOffer = { index, closesAt };
  q('#upgradeNo').textContent = `${index + 1}/2`;
  upgradePanel.hidden = false;
}

function hideUpgrade(): void {
  activeOffer = null;
  upgradePanel.hidden = true;
}

function showResult(snapshot: MatchSnapshot): void {
  resultPanel.hidden = false;
  q('#resultTitle').textContent = snapshot.winner === 'player' ? '勝利！' : snapshot.winner === 'rival' ? '敗北' : '引き分け';
  q('#resultScore').textContent = `${snapshot.scores.player.toLocaleString()}  vs  ${snapshot.scores.rival.toLocaleString()}`;
  startButton.disabled = false;
  startButton.textContent = 'もう一度勝負';
}

function resetBattleUi(): void {
  resultPanel.hidden = true;
  hideUpgrade();
  q('#pay').textContent = '';
  q('#lastSpin').textContent = '🍒　🔔　7';
  q('#rivalReels').textContent = '🍒　🔔　7';
  q('#heard').textContent = '';
  assistantText = '';
}

function handleSpin(player: SpinView, rival: SpinView): void {
  scene.spin();
  window.setTimeout(() => scene.show(player.symbols, player.payout), 320);
  q('#lastSpin').textContent = glyphs(player);
  q('#rivalReels').textContent = glyphs(rival);
  q('#pay').textContent = player.payout ? `+${player.payout.toLocaleString()}` : '';
  if (player.payout) window.setTimeout(() => (q('#pay').textContent = ''), 900);
}

function handlePracticeEvent(event: GameEvent): void {
  if (event.type === 'spin') handleSpin(event.player, event.rival);
  if (event.type === 'upgrade_open') {
    showUpgrade(event.offerIndex, event.closesAt);
    window.setTimeout(() => {
      if (!practiceState || practiceState.status !== 'playing') return;
      const pick: UpgradeId = practiceState.scores.rival < practiceState.scores.player ? 'jackpot' : Math.random() > 0.5 ? 'jackpot' : 'steady';
      submitUpgrade(practiceState, 'rival', event.offerIndex, pick, practiceState.elapsed);
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
    if (voiceReady && (!liveSnapshot || liveSnapshot.status === 'ready')) {
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
    assistantResetTimer = window.setTimeout(() => (assistantText = ''), 2500);
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
    if (!message.recoverable) startButton.disabled = true;
  }
}

async function connectLive(code: string): Promise<void> {
  if (liveClient) await liveClient.disconnect();
  voiceReady = false;
  liveSnapshot = null;
  resetBattleUi();
  q('#connection').textContent = 'マイク許可を確認中…';
  const client = new LiveClient(avatarVideo);
  liveClient = client;
  client.addEventListener('message', (event) => onLiveMessage((event as CustomEvent<ServerMessage>).detail));
  client.addEventListener('disconnect', () => {
    q('#connection').textContent = '通信が切断されました';
    voiceReady = false;
  });
  client.addEventListener('avatar-disconnect', () => (q('#connection').textContent = 'キャラクター映像が切断されました'));
  await client.connect(code);
  mode = 'live';
  modeBadge.textContent = 'LIVE AI';
  modeBadge.className = 'live';
  q('#mockFace').hidden = true;
}

async function waitForVoice(timeoutMs = 20_000): Promise<void> {
  const started = performance.now();
  while (!voiceReady) {
    if (performance.now() - started > timeoutMs) throw new Error('voice_timeout');
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
}

async function countdownThen(action: () => void): Promise<void> {
  const overlay = q<HTMLDivElement>('#countdown');
  overlay.hidden = false;
  for (const value of [3, 2, 1]) {
    overlay.textContent = String(value);
    await new Promise((resolve) => window.setTimeout(resolve, 450));
  }
  overlay.textContent = 'GO!';
  await new Promise((resolve) => window.setTimeout(resolve, 300));
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
  await waitForVoice();
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
  try {
    await connectLive(code);
    lastInviteCode = code;
    gate.hidden = true;
  } catch {
    q('#gateMessage').textContent = 'ライブ接続に失敗しました。マイク許可・招待コード・環境設定を確認するか、練習モードを利用してください。';
  } finally {
    q<HTMLButtonElement>('#liveConnect').disabled = false;
  }
};

q<HTMLButtonElement>('#practice').onclick = () => {
  mode = 'practice';
  gate.hidden = true;
  modeBadge.textContent = 'PRACTICE';
  modeBadge.className = 'practice';
  q('#connection').textContent = 'API未使用 / 練習モード';
  q('#mockFace').hidden = false;
  startButton.disabled = false;
};

startButton.onclick = () => {
  if (mode === 'practice') {
    if (practiceState?.status === 'playing') return;
    void countdownThen(startPractice);
  }
  if (mode === 'live') void startLiveOrRematch();
};

upgradePanel.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-up]');
  if (!button || !activeOffer) return;
  const upgradeId = button.dataset.up as UpgradeId;
  if (mode === 'practice' && practiceState) submitUpgrade(practiceState, 'player', activeOffer.index, upgradeId, practiceState.elapsed);
  if (mode === 'live') liveClient?.send({ type: 'upgrade', commandId: crypto.randomUUID(), upgradeId, offerIndex: activeOffer.index });
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
  q<HTMLButtonElement>('#sound').textContent = muted ? '音声 OFF' : '音声 ON';
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && mode === 'live') liveClient?.send({ type: 'snapshot' });
});

addEventListener('beforeunload', () => {
  stopPracticeTimer();
  void liveClient?.disconnect();
  scene.dispose();
});

renderSnapshot(getSnapshot(createMatch(1, 'preview')));
