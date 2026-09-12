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
import type { LiveClient } from './client/live';
import { submitCpuUpgrade } from './client/cpu';
import { ReelScene } from './view/ReelScene';
import { GameAudio } from './view/GameAudio';
import { RoundPresentation } from './view/RoundPresentation';
import { OVERLAYS, STAGE_HEIGHT, STAGE_WIDTH } from './view/StageLayout';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('missing_app');

app.innerHTML = `
<section class="shell" inert>
  <div id="stageArt" aria-hidden="true"></div>
  <header class="topbar">
    <h1 id="brand">Slot-chan <small>60 SECOND DUEL</small></h1>
    <div class="timer" id="timer"><small>残り</small><b id="time">60</b><span>秒</span></div>
    <div class="status-cluster" id="status"><span id="modeBadge">未接続</span><button id="sound" aria-label="AI音声をミュート" aria-pressed="false" hidden>AI音声 ON</button><button id="effects" aria-label="効果音をミュート" aria-pressed="false">効果音 ON</button><button id="leave">退出</button></div>
  </header>
  <div class="scores">
    <div class="you" id="playerScore"><span>♛ あなた</span><strong id="ps">0</strong><span class="score-meter" aria-hidden="true"><i id="playerMeter"></i></span></div>
    <div class="rival" id="rivalScore"><span>♜ ライバル</span><strong id="rs">0</strong><span class="score-meter" aria-hidden="true"><i id="rivalMeter"></i></span></div>
    <span class="duel-gap" id="scoreGap" role="status">互角の勝負</span>
  </div>
  <section class="machine" aria-label="あなたのスロット">
    <div id="machineTitle">SLOT-CHAN</div>
    <div class="event-cue" id="eventCue" role="status" hidden></div>
    <div class="pay" id="pay" aria-live="polite"></div>
    <div class="sr-only" id="lastSpin">チェリー・ベル・7</div>
    <div id="machineTrim">中央の1ラインで判定 · 60秒の獲得コインで勝負</div>
  </section>
  <aside class="avatar">
    <span class="sr-only" id="mockFace">CPUライバル</span>
    <video id="avatar" autoplay playsinline></video>
    <span id="rivalMood">正々堂々、60秒。</span>
    <p id="line">「60秒。私に勝てる？」</p>
    <small id="heard"></small>
    <div id="miniLabel">ライバルのリール <span>CPU</span></div>
    <strong class="sr-only" id="rivalReels">チェリー・ベル・7</strong>
    <div class="builds" id="builds"><div><span>あなたの改造</span><strong id="playerBuild">未改造</strong></div><div><span>相手の改造</span><strong id="rivalBuild">未改造</strong></div></div>
    <div class="connection" id="connection">接続していません</div>
  </aside>
  <div class="upgrade" id="upgrade" hidden>
    <div><b>リール改造</b><span id="upgradeNo"></span><small id="upgradeRemain"></small><small id="upgradeChoice" aria-live="polite" tabindex="-1"></small></div>
    <button data-up="steady" aria-pressed="false"><span class="symbol-icon cherry" aria-hidden="true"></span><strong>安定型</strong><small>${UPGRADE_DEFINITIONS.steady.description}</small><kbd>1</kbd></button>
    <button data-up="jackpot" aria-pressed="false"><span class="symbol-icon seven" aria-hidden="true"></span><strong>大勝負</strong><small>${UPGRADE_DEFINITIONS.jackpot.description}</small><kbd>2</kbd></button>
  </div>
  <footer>
    <div class="result" id="result" role="status" hidden><small>DUEL FINISHED</small><strong id="resultTitle"></strong><span id="resultScore"></span><p>改造を変えて、もう一度。</p></div>
    <button id="start" disabled>勝負する</button>
    <div id="paytable" aria-label="3つそろうとチェリー120、ベル240、7は1200点"><span><i class="symbol-icon cherry"></i>${PAYOUT.cherry}</span><span><i class="symbol-icon bell"></i>${PAYOUT.bell}</span><span><i class="symbol-icon seven"></i>1,200</span></div>
    <div id="upgradeProgress">⚙ リール改造<small>20秒・40秒で選択</small></div>
  </footer>
</section>
<div class="gate" id="gate" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
  <div class="gate-card">
    <div class="eyebrow">SLOT-CHAN · 60 SECOND DUEL</div>
    <h2 id="gateTitle">回して、改造して。<br><em>ライバルを超えろ。</em></h2>
    <p>60秒のスロット対戦。<br>20秒・40秒でリールを改造し、<br>ライバルより多くのコインを手に入れよう。</p>
    <div class="gate-payout"><span class="symbol-icon cherry"></span><span class="symbol-icon bell"></span><span class="symbol-icon seven"></span><span>回転は自動。選ぶのは、勝ち方。</span></div>
    <button id="practice" class="primary">CPUライバルと対戦 <span>→</span></button>
    <small>PC用・無料・マイク不要。横画面1280×720以上で遊べます。</small>
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

function placeOverlay(): void {
  for (const [id, rect] of Object.entries(OVERLAYS)) {
    Object.assign(q('#' + id).style, { position: 'absolute', left: `${rect.x / STAGE_WIDTH * 100}%`, top: `${rect.y / STAGE_HEIGHT * 100}%`, width: `${rect.w / STAGE_WIDTH * 100}%`, height: `${rect.h / STAGE_HEIGHT * 100}%` });
  }
}
placeOverlay();
const scene = new ReelScene(q('#stageArt'));
const presentation = new RoundPresentation({
  play: (player, rival, stopped) => scene.play(player, rival, stopped),
  settled: revealRound,
  ended: finishPresentation,
});
let latestSnapshot: MatchSnapshot | null = null;
let reactionUntil = 0;
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
let beforeUpgradeFocus: HTMLElement | null = null;
const battleTimers = new Set<number>();

function focusBattleControl(): void {
  (startButton.disabled ? q<HTMLButtonElement>('#leave') : startButton).focus();
}

function setGateVisible(visible: boolean): void {
  q('.shell').inert = visible;
  gate.hidden = !visible;
  if (visible) q('#practice').focus();
  else focusBattleControl();
}

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
  presentation.reset();
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
  setGateVisible(true);
  startButton.disabled = true;
  q<HTMLButtonElement>('#liveConnect').disabled = false;
  q('#gateMessage').textContent = message;
  avatarVideo.hidden = true;
  q('#mockFace').hidden = false;
}

function glyphs(spin: SpinView): string {
  const glyph = { cherry: 'チェリー', bell: 'ベル', seven: '7' } as const;
  return spin.symbols.map((symbol) => glyph[symbol]).join('　');
}

function renderSnapshot(snapshot: MatchSnapshot): void {
  latestSnapshot = snapshot;
  const scores = presentation.scores;
  q('#time').textContent = String(Math.max(0, Math.ceil(snapshot.remaining))).padStart(2, '0');
  q('#ps').textContent = scores.player.toLocaleString();
  q('#rs').textContent = scores.rival.toLocaleString();
  const total = scores.player + scores.rival;
  const gap = scores.player - scores.rival;
  q('#playerMeter').style.width = `${total ? scores.player / total * 100 : 50}%`;
  q('#rivalMeter').style.width = `${total ? scores.rival / total * 100 : 50}%`;
  const gapText = gap === 0 ? '互角の勝負' : `${Math.abs(gap).toLocaleString()}点 ${gap > 0 ? 'リード' : 'ビハインド'}`;
  if (q('#scoreGap').textContent !== gapText) q('#scoreGap').textContent = gapText;
  q('#scoreGap').dataset.leader = gap > 0 ? 'player' : gap < 0 ? 'rival' : 'draw';
  if (performance.now() >= reactionUntil) scene.setExpression(gap > 0 ? 'frustrated' : gap < 0 ? 'confident' : 'neutral');
  q('#rivalMood').textContent = snapshot.status === 'result' ? (gap > 0 ? '次こそ、負けない。' : gap < 0 ? 'もう一度、挑む？' : '決着は、次の勝負で。') : gap > 0 ? 'ここから、巻き返す。' : gap < 0 ? 'このまま、逃げきる。' : '正々堂々、60秒。';
  const buildLabel = (upgrades: UpgradeId[]) => upgrades.length ? upgrades.map(id => id === 'steady' ? '安定型' : '大勝負').join(' / ') : '未改造';
  q('#playerBuild').textContent = buildLabel(snapshot.upgrades.player);
  q('#rivalBuild').textContent = buildLabel(snapshot.upgrades.rival);
  q('#upgradeProgress').textContent = snapshot.status === 'playing' ? activeOffer ? '改造を選ぼう！' : snapshot.elapsed < 20 ? `改造まで ${Math.ceil(20 - snapshot.elapsed)}秒` : snapshot.elapsed < 40 ? `次の改造まで ${Math.ceil(40 - snapshot.elapsed)}秒` : '改造完了・ラストスパート' : snapshot.status === 'result' ? '対戦終了' : '改造チャンス 20秒・40秒';
  q('#time').parentElement!.classList.toggle('urgent', snapshot.status === 'playing' && snapshot.remaining <= 10);
  if (snapshot.status === 'playing') {
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
  q('#eventCue').dataset.kind = sound;
  q('#eventCue').hidden = false;
  effects.play(sound);
  cueTimer = window.setTimeout(() => { q('#eventCue').hidden = true; }, 1800);
}

function showUpgrade(index: 0 | 1, closesAt: number): void {
  beforeUpgradeFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  effects.play('choose');
  activeOffer = { index, closesAt };
  q('#upgradeNo').textContent = `${index + 1}/2`;
  q('#upgradeChoice').textContent = 'どちらか1つを選んで確定';
  upgradePanel.querySelectorAll('button').forEach((button) => {
    button.disabled = false;
    button.setAttribute('aria-pressed', 'false');
  });
  upgradePanel.hidden = false;
  q('.shell').dataset.upgrading = 'true';
  upgradePanel.querySelector<HTMLButtonElement>('button')?.focus();
}

function hideUpgrade(): void {
  const restoreFocus = upgradePanel.contains(document.activeElement);
  activeOffer = null;
  upgradePanel.hidden = true;
  q('.shell').dataset.upgrading = 'false';
  if (restoreFocus) {
    if (beforeUpgradeFocus?.isConnected && !beforeUpgradeFocus.matches(':disabled') && !beforeUpgradeFocus.closest('[inert], [hidden]')) beforeUpgradeFocus.focus();
    else focusBattleControl();
  }
  beforeUpgradeFocus = null;
}

function showResult(snapshot: MatchSnapshot): void {
  const scores = snapshot.scores;
  effects.play('result');
  resultPanel.hidden = false;
  q('#resultTitle').textContent = snapshot.winner === 'player' ? '勝利！' : snapshot.winner === 'rival' ? '敗北' : '引き分け';
  q('#resultScore').textContent = `${scores.player.toLocaleString()}  vs  ${scores.rival.toLocaleString()}`;
  startButton.disabled = false;
  startButton.textContent = '再戦する';
  startButton.focus();
}

function resetBattleUi(): void {
  presentation.reset();
  scene.stop();
  reactionUntil = 0;
  scene.setExpression('neutral');
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
  q('#lastSpin').textContent = 'チェリー・ベル・7';
  q('#rivalReels').textContent = 'チェリー・ベル・7';
  scene.show(['cherry', 'bell', 'seven']);
  q('#line').textContent = '「60秒。私に勝てる？」';
  q('#heard').textContent = '';
  assistantText = '';
}

function handleSpin(player: SpinView, rival: SpinView): void {
  if (presentation.spin(player, rival)) {
    q('#pay').textContent = '';
    clearTimeout(cueTimer);
    q('#eventCue').hidden = true;
    effects.play('spin');
  }
}

function revealRound(player: SpinView, rival: SpinView, celebrate: boolean): void {
  q('#lastSpin').textContent = glyphs(player);
  q('#rivalReels').textContent = glyphs(rival);
  const leader = player.total > rival.total ? 'player' : player.total < rival.total ? 'rival' : null;
  const comeback = leader && previousLeader && leader !== previousLeader;
  if (leader) previousLeader = leader;
  if (latestSnapshot) renderSnapshot(latestSnapshot);
  const stale = !celebrate || document.hidden || (latestSnapshot?.round ?? player.round) > player.round;
  if (stale) return;
  q('#pay').textContent = player.payout ? `+${player.payout.toLocaleString()}` : '';
  q('#pay').dataset.jackpot = String(player.payout >= PAYOUT.seven);
  if (player.payout) later(() => { q('#pay').textContent = ''; }, player.payout >= PAYOUT.seven ? 1200 : 650);
  reactionUntil = performance.now() + 1600;
  if (player.payout >= PAYOUT.seven) {
    scene.setExpression('surprised');
    q('#line').textContent = '「ちょっと待って、今のは聞いてない！」';
    announce(comeback && leader === 'player' ? '逆転！' : '7揃い！', 'jackpot');
  } else if (comeback) {
    scene.setExpression(leader === 'player' ? 'surprised' : 'confident');
    q('#line').textContent = leader === 'player' ? '「えっ、そこで逆転する！？」' : '「ほら、まだまだ勝負はこれから。」';
    announce(leader === 'player' ? '逆転！' : 'ライバルが逆転！', 'lead');
  } else if (player.payout) {
    scene.setExpression('surprised');
    q('#line').textContent = '「えっ、そこで当てる！？」';
    effects.play('win');
  } else if (rival.payout) {
    scene.setExpression('confident');
    q('#line').textContent = '「いい感じ。このまま行くよ。」';
  } else {
    scene.setExpression('neutral');
  }
}

function finishPresentation(snapshot: MatchSnapshot): void {
  renderSnapshot(snapshot);
  showResult(snapshot);
  hideUpgrade();
  scene.stop();
  q('#pay').textContent = '';
  clearTimeout(cueTimer);
  q('#eventCue').hidden = true;
  scene.setExpression(snapshot.winner === 'player' ? 'frustrated' : snapshot.winner === 'rival' ? 'confident' : 'neutral');
  reactionUntil = performance.now() + 3600000;
  q('#line').textContent = snapshot.winner === 'player' ? '「……負けた。もう一回！」' : snapshot.winner === 'rival' ? '「私の勝ち。再戦する？」' : '「引き分け？ 次で決めよう。」';
}

function handlePracticeEvent(event: GameEvent): void {
  if (event.type === 'spin') handleSpin(event.player, event.rival);
  if (event.type === 'upgrade_open' && (practiceState?.elapsed ?? 60) < event.closesAt) {
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
  if (event.type === 'match_end') {
    stopPracticeTimer();
    presentation.end(event.snapshot);
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
  startButton.textContent = '自動回転中';
  practiceTimer = window.setInterval(() => {
    if (!practiceState) return;
    const elapsed = (performance.now() - practiceStartedAt) / 1000;
    const events = advanceMatch(practiceState, elapsed);
    const newestSpin = events.filter(event => event.type === 'spin').at(-1);
    events.filter(event => event.type !== 'spin' || event === newestSpin).forEach(handlePracticeEvent);
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
    avatarVideo.hidden = !voiceReady;
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
      startButton.textContent = '勝負する';
    }
    return;
  }
  if (message.type === 'snapshot') {
    liveSnapshot = message.snapshot;
    if (message.lastSpin) handleSpin(message.lastSpin.player, message.lastSpin.rival);
    renderSnapshot(message.snapshot);
    if (message.snapshot.status === 'result') presentation.end(message.snapshot);
    if (message.snapshot.status === 'playing' && !activeOffer) {
      const elapsed = message.snapshot.elapsed;
      if (elapsed >= 20 && elapsed < 24) showUpgrade(0, 24);
      if (elapsed >= 40 && elapsed < 44) showUpgrade(1, 44);
    }
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
    presentation.end(message.snapshot);
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
  const { LiveClient } = await import('./client/live');
  if (current !== revision) throw new Error('connection_cancelled');
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
  avatarVideo.hidden = !voiceReady;
}

async function countdownThen(action: () => void): Promise<void> {
  const current = revision;
  const overlay = q<HTMLDivElement>('#countdown');
  overlay.hidden = false;
  q('#leave').focus();
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
  startButton.textContent = '自動回転中';
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
    setGateVisible(false);
    q<HTMLInputElement>('#invite').value = '';
  } catch {
    if (revision === attempt) prepareCpuMatch('音声・映像を利用できないため、CPU対戦を準備しました。開始ボタンで遊べます。');
  } finally {
    if (revision === attempt) q<HTMLButtonElement>('#liveConnect').disabled = false;
  }
};

function prepareCpuMatch(message = 'CPU対戦 · 自動回転 · 改造チャンスは2回'): void {
  cancelBattle();
  resetBattleUi();
  renderSnapshot(getSnapshot(createMatch(1, 'preview')));
  mode = 'practice';
  q<HTMLButtonElement>('#liveConnect').disabled = false;
  setGateVisible(false);
  modeBadge.textContent = 'CPU対戦';
  modeBadge.className = 'practice';
  q('#sound').hidden = true;
  avatarVideo.hidden = true;
  q('#connection').textContent = message;
  q('#line').textContent = '「60秒。私に勝てる？」';
  q('#mockFace').hidden = false;
  startButton.disabled = false;
  startButton.textContent = '勝負する';
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
    if (mode === 'practice' && practiceState?.status !== 'playing') {
      resetBattleUi();
      renderSnapshot(getSnapshot(createMatch(1, 'preview')));
      startButton.textContent = '準備中';
      await countdownThen(startPractice);
    }
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
  q('#upgradeChoice').textContent = `選択済み: ${upgradeId === 'steady' ? '安定型' : '大勝負'}`;
  q('#upgradeChoice').focus();
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
avatarVideo.hidden = true;

if (import.meta.env.DEV && new URLSearchParams(location.search).has('visual-review')) {
  void import('./view/VisualReview').then(({ mountVisualReview }) => mountVisualReview({
    scene,
    reset: () => { prepareCpuMatch(); resetBattleUi(); },
    spin: handleSpin,
    snapshot: renderSnapshot,
    preview: example => {
      prepareCpuMatch();
      resetBattleUi();
      const snapshot: MatchSnapshot = { matchId: 'visual-fixture', status: 'playing', elapsed: 42, remaining: 18, round: 21, scores: { player: 1440, rival: 1200 }, upgrades: { player: ['steady', 'jackpot'], rival: ['steady', 'steady'] }, eventSeq: 1 };
      presentation.scores = { ...snapshot.scores };
      renderSnapshot(snapshot);
      startButton.textContent = '自動回転中';
      startButton.disabled = true;
      if (example === 'normal') scene.show(['bell', 'seven', 'cherry']);
      if (example === 'small' || example === 'jackpot') {
        const jackpot = example === 'jackpot';
        const symbols: SpinView['symbols'] = jackpot ? ['seven', 'seven', 'seven'] : ['cherry', 'cherry', 'cherry'];
        const p: SpinView = { side: 'player', round: 21, symbols, payout: jackpot ? 1200 : 120, total: jackpot ? 3600 : 1440 };
        const r: SpinView = { side: 'rival', round: 21, symbols: ['bell', 'seven', 'cherry'], payout: 0, total: jackpot ? 3240 : 1200 };
        previousLeader = jackpot ? 'rival' : 'player';
        presentation.scores = { player: p.total, rival: r.total };
        if (jackpot) { snapshot.remaining = 8; snapshot.elapsed = 52; }
        renderSnapshot(snapshot);
        scene.show(p.symbols, p.payout, r.symbols, true);
        revealRound(p, r, true);
        battleTimers.forEach(clearTimeout);
        battleTimers.clear();
        clearTimeout(cueTimer);
      }
      if (example === 'draw') {
        snapshot.status = 'result'; snapshot.remaining = 0; snapshot.elapsed = 60;
        snapshot.scores = { player: 1440, rival: 1440 }; snapshot.winner = 'draw';
        presentation.scores = { ...snapshot.scores };
        finishPresentation(snapshot);
      }
      if (example === 'upgrade') showUpgrade(1, 44);
      if (example === 'final') {
        snapshot.status = 'result'; snapshot.round = 30; snapshot.remaining = 0; snapshot.elapsed = 60;
        snapshot.scores = { player: 3600, rival: 3240 }; snapshot.winner = 'player';
        renderSnapshot(snapshot);
        handleSpin({ side: 'player', round: 30, symbols: ['seven', 'seven', 'seven'], payout: 1200, total: 3600 }, { side: 'rival', round: 30, symbols: ['cherry', 'bell', 'seven'], payout: 0, total: 3240 });
        presentation.end(snapshot);
      }
    },
  }));
}
