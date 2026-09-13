import type { MatchSnapshot, SpinView } from '../../shared/protocol';
import { PAYOUT } from '../domain/game';
import { upgradePrice } from '../../shared/shop';
import type { GameCommands, GamePresentation, GameSound, GameViewState } from '../viewmodel/GameViewState';
import { GameAudio } from './GameAudio';
import { mountGameTemplate } from './GameTemplate';
import { ReelScene } from './ReelScene';
import { OVERLAYS, STAGE_HEIGHT, STAGE_WIDTH } from './StageLayout';

/** DOM, focus and Three.js presentation. All match transitions arrive as state. */
export class GameView implements GamePresentation {
  readonly scene: ReelScene;
  readonly video: HTMLVideoElement;
  private readonly audio = new GameAudio();
  private readonly elements = new Map<string, HTMLElement>();
  private events = new AbortController();
  private current: GameViewState | null = null;
  private resultKey = '';
  private disposed = false;

  constructor(private readonly app: HTMLElement) {
    mountGameTemplate(app);
    for (const [id, rect] of Object.entries(OVERLAYS)) {
      Object.assign(this.q('#' + id).style, {
        position: 'absolute', left: `${rect.x / STAGE_WIDTH * 100}%`, top: `${rect.y / STAGE_HEIGHT * 100}%`,
        width: `${rect.w / STAGE_WIDTH * 100}%`, height: `${rect.h / STAGE_HEIGHT * 100}%`,
      });
    }
    this.video = this.q<HTMLVideoElement>('#avatar');
    this.scene = new ReelScene(this.q('#stageArt'), (side, column) => this.audio.reelStop(side, column));
  }

  private q<T extends HTMLElement = HTMLElement>(selector: string): T {
    let element = this.elements.get(selector);
    if (!element) {
      element = this.app.querySelector<HTMLElement>(selector) ?? undefined;
      if (!element) throw new Error(`missing_element:${selector}`);
      this.elements.set(selector, element);
    }
    return element as T;
  }

  private text(selector: string, value: string): void {
    const element = this.q(selector);
    if (element.textContent !== value) element.textContent = value;
  }

  bind(commands: GameCommands): void {
    this.events.abort();
    this.events = new AbortController();
    const options = { signal: this.events.signal };
    const unlock = () => { void this.audio.unlock(); };
    for (const [selector, id] of [['#buySteady', 'steady'], ['#buyJackpot', 'jackpot']] as const) {
      this.q(selector).addEventListener('click', event => {
        unlock();
        commands.purchaseUpgrade(id);
        if (event.detail > 0) this.focus('start');
      }, options);
    }
    this.q('#practice').addEventListener('click', () => { unlock(); void commands.startCpu(); }, options);
    this.q('#start').addEventListener('click', () => {
      unlock();
      if (this.current?.snapshot.status === 'playing') commands.requestSpin();
      else void commands.start();
    }, options);
    this.q('#liveConnect').addEventListener('click', () => {
      unlock();
      const input = this.q<HTMLInputElement>('#invite');
      const code = input.value.trim();
      void commands.connectLive(code, this.q<HTMLInputElement>('#avatarVideo').checked).then(() => { if (!this.current?.gate.visible) input.value = ''; });
    }, options);
    this.q('#leave').addEventListener('click', () => commands.leave(), options);
    this.q('#mic').addEventListener('click', event => {
      commands.toggleMicMuted();
      if (event.detail > 0 && this.current?.snapshot.status === 'playing') this.q('#start').focus({ preventScroll: true });
    }, options);
    this.q('#sound').addEventListener('click', () => commands.toggleVoiceMuted(), options);
    this.q('#effects').addEventListener('click', () => { unlock(); commands.toggleEffectsMuted(); }, options);
    addEventListener('keydown', event => {
      const state = this.current;
      if (!state || state.gate.visible) return;
      // Early spin input stays on the countdown instead of activating another control.
      if (event.code === 'Space' && state.countdown !== null && event.target === this.q('#countdown')) {
        event.preventDefault();
        return;
      }
      if (event.code === 'Space' && state.snapshot.status === 'playing') {
        const control = event.target instanceof Element ? event.target.closest('input,textarea,select,summary,button') : null;
        if (control && control !== this.q('#start')) return;
        event.preventDefault();
        if (!event.repeat) { unlock(); commands.requestSpin(); }
        return;
      }
    }, options);
    document.addEventListener('visibilitychange', () => commands.visibilityChanged(), options);
  }

  render(state: GameViewState): void {
    if (this.disposed) return;
    const previous = this.current;
    this.current = state;
    this.q('.shell').inert = state.gate.visible;
    this.q('#gate').hidden = !state.gate.visible;
    this.text('#gateMessage', state.gate.message);
    this.q<HTMLButtonElement>('#liveConnect').disabled = state.gate.connecting;
    if (previous && !previous.gate.visible && state.gate.visible) this.audio.dispose();
    this.text('#modeBadge', state.modeBadge.text);
    this.q('#modeBadge').className = state.modeBadge.tone === 'idle' ? '' : state.modeBadge.tone;
    this.text('#connection', state.connection.text);
    this.video.hidden = !state.connection.showVideo;
    this.q('#mockFace').hidden = state.connection.showVideo;
    this.q('#sound').hidden = !state.connection.showVoiceControls;
    this.text('#sound', state.voiceMuted ? 'VOICE OFF' : 'VOICE ON');
    this.q('#sound').setAttribute('aria-label', state.voiceMuted ? 'Unmute AI voice' : 'Mute AI voice');
    this.q('#sound').setAttribute('aria-pressed', String(state.voiceMuted));
    const mic = state.microphone;
    this.q('#voicePanel').hidden = !mic.visible;
    this.q('#duelRules').hidden = mic.visible;
    this.q('#voicePanel').dataset.muted = String(mic.muted || !mic.active);
    const micButton = this.q<HTMLButtonElement>('#mic');
    micButton.disabled = !mic.active;
    micButton.setAttribute('aria-pressed', String(mic.muted));
    micButton.setAttribute('aria-label', mic.muted ? 'Unmute your microphone' : 'Mute your microphone');
    this.text('#micLabel', mic.active && !mic.muted ? 'MIC ON' : 'MIC OFF');
    this.text('#micState', !mic.active ? 'MIC OFF' : mic.muted ? 'MIC MUTED' : mic.level ? 'INPUT DETECTED' : 'MIC LIVE');
    this.text('#micHint', !mic.active ? 'Your microphone is off.' : mic.muted ? state.voiceMuted ? 'Mic and rival voice are muted.' : 'You can still hear your rival.' : state.voiceMuted ? 'Your mic is on. Rival voice is muted.' : 'Talk while you play.');
    this.q('.mic-meter').querySelectorAll('i').forEach((bar, index) => bar.classList.toggle('active', index < mic.level));
    this.text('#effects', state.effectsMuted ? 'SOUND OFF' : 'SOUND ON');
    this.q('#effects').setAttribute('aria-label', state.effectsMuted ? 'Unmute sound effects' : 'Mute sound effects');
    this.q('#effects').setAttribute('aria-pressed', String(state.effectsMuted));

    const snapshot = state.snapshot;
    const upgrades = snapshot.upgrades.player;
    for (const [id, selector, base, added] of [['steady', '#buySteady', 4, 6], ['jackpot', '#buyJackpot', 2, 1]] as const) {
      const count = upgrades.filter(value => value === id).length;
      const price = upgradePrice(upgrades, id);
      const button = this.q<HTMLButtonElement>(selector);
      button.disabled = snapshot.status !== 'playing' || price === null || Math.min(state.scores.player, snapshot.scores.player) < price;
      this.text(selector, price === null ? 'MAX' : `BUY $${price}`);
      this.text(`#${id}Level`, `${base + added * count} IN REEL · ${count}/3`);
    }
    const spent = snapshot.upgradeSpent ?? 0;
    const oldSpent = previous?.snapshot.upgradeSpent ?? 0;
    if (spent > oldSpent && previous?.snapshot.matchId === snapshot.matchId) {
      const id = upgrades[upgrades.length - 1];
      this.text('#purchaseNotice', `−$${spent - oldSpent} · ${id === 'steady' ? '+6 CHERRIES' : '+1 SEVEN'} · NEXT SPIN`);
      this.audio.play('choose');
      this.q('#ps').animate([{ color: '#ffae75' }, { color: '#fff1be' }], { duration: 700 });
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const symbol = this.q('#purchaseSymbol');
        symbol.className = `symbol-icon ${id === 'steady' ? 'cherry' : 'seven'}`;
        symbol.animate([{ opacity: 1, transform: 'translate(0,0) scale(1)' }, { opacity: 1, offset: .75 }, { opacity: 0, transform: 'translate(-12cqw,-18cqw) scale(1.8)' }], { duration: 850, easing: 'ease-in' });
      }
    } else if (spent === 0) this.text('#purchaseNotice', 'BUY → BOOST YOUR NEXT SPIN');
    this.scene.setUpgrades(snapshot.upgrades.player, snapshot.upgrades.rival);
    this.scene.setExpression(state.expression);
    const seconds = Math.max(0, Math.ceil(snapshot.remaining));
    this.text('#time', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
    const finale = snapshot.status === 'playing' && seconds > 0 && seconds <= 10 && !state.gate.visible;
    this.q('#timer').classList.toggle('urgent', finale);
    this.q('.shell').dataset.finale = String(finale);
    this.text('#timerCaption', finale ? 'FINAL SECONDS' : 'TIME LEFT');
    this.scene.setFinalSeconds(finale ? seconds : 0);
    if (finale && previous && Math.ceil(previous.snapshot.remaining) !== seconds && !document.hidden) {
      if (seconds <= 5) this.audio.countdownTick(seconds, state.connection.voiceReady);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.q('#time').animate([
        { transform: 'scale(1.12)', color: '#fff4d0' },
        { transform: 'scale(1)', color: '#ffac8c' },
      ], { duration: 260, easing: 'ease-out' });
    }
    this.text('#ps', '$' + state.scores.player.toLocaleString());
    this.text('#rs', '$' + state.scores.rival.toLocaleString());
    const total = state.scores.player + state.scores.rival;
    const gap = state.scores.player - state.scores.rival;
    this.q('#playerMeter').style.width = `${total ? state.scores.player / total * 100 : 50}%`;
    this.q('#rivalMeter').style.width = `${total ? state.scores.rival / total * 100 : 50}%`;
    this.text('#scoreGap', gap === 0 ? 'EVEN' : `${Math.abs(gap).toLocaleString()} ${gap > 0 ? 'AHEAD' : 'BEHIND'}`);
    this.q('#scoreGap').dataset.leader = gap > 0 ? 'player' : gap < 0 ? 'rival' : 'draw';
    this.text('#rivalMood', state.conversation === 'listening' ? 'LISTENING TO YOU' : state.conversation === 'replying' ? 'RIVAL REPLY' : state.rivalMood);
    this.q('#rivalMood').dataset.conversation = state.conversation;
    this.q('#line').dataset.conversation = state.conversation;
    this.q('#line').dataset.long = String(Array.from(state.line).reduce((width, letter) => width + (letter.charCodeAt(0) > 127 ? 2 : 1), 0) > 78);
    this.text('#line', state.line);
    this.text('#heard', state.heard);
    this.text('#machineTrim', state.machineNotice);
    this.text('#roundCount', String(snapshot.rounds.player).padStart(2, '0'));
    this.text('#rivalRoundCount', String(snapshot.rounds.rival).padStart(2, '0'));
    this.text('#lastSpin', state.lastSpin?.player ? this.glyphs(state.lastSpin.player) : 'Cherry, Bell, Seven');
    this.text('#rivalReels', state.lastSpin?.rival ? this.glyphs(state.lastSpin.rival) : 'Cherry, Bell, Seven');

    this.text('#pay', state.payout?.player ? `+$${state.payout.player.toLocaleString()}` : '0');
    this.text('#winLabel', state.payout?.player ? 'WIN' : 'MATCH 3 · WIN BIG');
    this.q('#pay').dataset.jackpot = String((state.payout?.player ?? 0) >= PAYOUT.seven);
    this.text('#rivalPay', state.payout?.rival ? `+$${state.payout.rival.toLocaleString()}` : '');
    this.q('#rivalPay').dataset.jackpot = String((state.payout?.rival ?? 0) >= PAYOUT.seven);
    this.q('#rivalPay').hidden = !state.payout?.rival;
    this.text('#rivalWinLabel', (state.payout?.rival ?? 0) >= PAYOUT.seven ? 'BIG WIN' : state.payout?.rival ? 'WIN' : 'RIVAL REELS');
    this.q('#miniLabel').dataset.win = String(!!state.payout?.rival);
    this.q('#miniLabel').dataset.jackpot = String((state.payout?.rival ?? 0) >= PAYOUT.seven);
    this.q('#machineTitle').dataset.win = String(!!state.payout?.player);
    this.q('#playerScore').dataset.win = String(!!state.payout?.player);
    this.q('#rivalScore').dataset.win = String(!!state.payout?.rival);
    const reward = state.payout?.player ?? 0;
    const burst = this.q('#winBurst');
    burst.hidden = !reward || !!state.result;
    burst.dataset.jackpot = String(reward >= PAYOUT.seven);
    this.text('#winBurstAmount', '+$' + reward.toLocaleString());
    this.text('#winBurstLabel', reward >= PAYOUT.seven ? 'BIG WIN' : reward >= PAYOUT.bell ? 'BELL WIN' : 'CHERRY WIN');
    this.q('#scoreGap').hidden = !burst.hidden || !!state.result;
    if (previous && !state.result && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const side of ['player', 'rival'] as const) {
        const spin = state.lastSpin?.[side];
        if (!spin?.payout || spin.round === previous.lastSpin?.[side]?.round) continue;
        this.q(side === 'player' ? '#ps' : '#rs').animate([
          { transform: 'scale(1)', color: '#fff' },
          { transform: 'scale(1.12)', color: '#fff' , offset: .22 },
          { transform: 'scale(1)', color: '#fff1be' },
        ], { duration: 480, easing: 'cubic-bezier(.2,.8,.3,1)' });
      }
    }
    this.q('#eventCue').hidden = !state.cue || state.cue.kind === 'jackpot';
    if (state.cue) {
      this.text('#eventCue', state.cue.text);
      this.q('#eventCue').dataset.kind = state.cue.kind;
    }
    const start = this.q<HTMLButtonElement>('#start');
    start.disabled = state.startControl.disabled;
    this.text('#start', state.startControl.label);
    this.scene.setButtonCaption(state.startControl.label);
    if (state.startControl.spinState) start.dataset.spin = state.startControl.spinState;
    else delete start.dataset.spin;
    this.text('#spinHint', state.startControl.hint);
    this.text('#queueStatus', state.startControl.spinState === 'queued' ? 'NEXT SPIN QUEUED ✓' : state.result ? 'START A NEW ROUND' : 'CLICK TO SPIN');
    this.q('#roundStatus').dataset.queued = String(state.startControl.spinState === 'queued');
    this.q('#roundStatus').hidden = state.mode === 'live';
    this.q('#connection').hidden = state.mode !== 'live' || state.microphone.visible;
    const record = state.sessionRecord;
    this.q('#bestRun').hidden = !record.best;
    this.q('#spaceKey').hidden = !!record.best;
    this.text('#bestScore', '$' + record.best.toLocaleString());
    this.text('#recordCoins', '$' + record.best.toLocaleString());
    this.text('#recordStreak', record.streak ? '× ' + record.streak : '—');
    this.text('#recordLabel', record.newBest ? 'NEW PERSONAL BEST' : 'SESSION BEST');
    this.q('#resultRecords').dataset.record = String(record.newBest);
    this.renderResult(state.result);
    this.scene.setResult(state.result ? state.result.winner ?? 'draw' : null);
    this.q('#countdown').hidden = state.countdown === null;
    if (state.countdown !== null) {
      this.text('#countdownValue', String(state.countdown));
      this.q('#countdown').dataset.phase = state.countdown === 'GO!' ? 'go' : 'ready';
      if (previous?.countdown === null) this.q('#countdown').focus({ preventScroll: true });
    }
  }

  private glyphs(spin: SpinView): string {
    const glyph = { cherry: 'Cherry', bell: 'Bell', seven: 'Seven' };
    return spin.symbols.map(symbol => glyph[symbol]).join(', ');
  }

  private renderResult(snapshot: MatchSnapshot | null): void {
    const panel = this.q('#result');
    panel.hidden = !snapshot;
    if (!snapshot) {
      if (this.resultKey) {
        this.q<HTMLDetailsElement>('#resultDetails').open = false;
        this.q('#resultStats').replaceChildren();
      }
      this.resultKey = '';
      return;
    }
    const key = `${snapshot.matchId}:${snapshot.rounds.player}:${snapshot.rounds.rival}:${snapshot.scores.player}:${snapshot.scores.rival}`;
    if (key === this.resultKey) return;
    this.resultKey = key;
    panel.dataset.outcome = snapshot.winner ?? 'draw';
    this.text('#resultRounds', '60 SECOND DUEL');
    this.q<HTMLDetailsElement>('#resultDetails').open = false;
    this.text('#resultEnglish', 'ROUND COMPLETE');
    this.text('#resultTitle', snapshot.winner === 'player' ? 'YOU WIN!' : snapshot.winner === 'rival' ? 'RIVAL WINS' : 'DRAW');
    this.text('#resultPlayer', '$' + snapshot.scores.player.toLocaleString());
    this.text('#resultRival', '$' + snapshot.scores.rival.toLocaleString());
    const margin = Math.abs(snapshot.scores.player - snapshot.scores.rival).toLocaleString();
    this.text('#resultGap', snapshot.winner === 'player' ? `You won by $${margin}.` : snapshot.winner === 'rival' ? `$${margin} behind. Go again?` : 'Same cash. One more round to settle it.');
    this.text('#resultAgain', snapshot.winner === 'player' ? 'Keep the streak going. One more round?' : 'Beat your best. Your next spin could change everything.');
    const rows = this.q<HTMLTableSectionElement>('#resultStats');
    rows.replaceChildren();
    const addRow = (label: string, player: string, rival: string, symbol?: string) => {
      const row = rows.insertRow();
      const title = document.createElement('th');
      title.scope = 'row';
      if (symbol) {
        const icon = document.createElement('i');
        icon.className = `symbol-icon ${symbol}`;
        icon.setAttribute('aria-hidden', 'true');
        title.append(icon);
      }
      title.append(document.createTextNode(label));
      row.append(title);
      row.insertCell().textContent = player;
      row.insertCell().textContent = rival;
    };
    addRow('SPINS', String(snapshot.rounds.player), String(snapshot.rounds.rival));
    addRow('UPGRADES', `−$${snapshot.upgradeSpent ?? 0}`, '$0');
    for (const [symbol, label] of [['cherry', 'CHERRY'], ['bell', 'BELL'], ['seven', 'SEVEN']] as const) {
      const value = (side: 'player' | 'rival') => {
        const count = snapshot.stats[side].wins[symbol];
        return `${count} ${count === 1 ? 'HIT' : 'HITS'} · $${(count * PAYOUT[symbol]).toLocaleString()}`;
      };
      addRow(label, value('player'), value('rival'), symbol);
    }
    const best = (side: 'player' | 'rival') => {
      const spin = snapshot.stats[side].bestSpin;
      return spin ? `$${spin.payout.toLocaleString()} · SPIN ${spin.round}` : 'NO WIN';
    };
    addRow('BEST SPIN', best('player'), best('rival'));
  }

  playSpin(spin: SpinView, stopped: (celebrate?: boolean) => void): void {
    this.scene.playSide(spin, stopped);
  }
  resetScene(): void {
    this.scene.stop();
    this.scene.setUpgrades([], []);
    this.scene.setExpression('neutral');
    this.scene.show(['cherry', 'bell', 'seven']);
  }
  stopScene(): void { this.scene.stop(); }
  celebrateResult(winner: 'player' | 'rival' | 'draw'): void { this.scene.celebrateResult(winner); }
  playSound(cue: GameSound): void { this.audio.play(cue); }
  stopSound(): void { this.audio.stop(); }
  setEffectsMuted(muted: boolean): void { this.audio.setMuted(muted); }
  focus(target: 'start' | 'gate'): void {
    if (target === 'gate') this.q('#practice').focus();
    else (this.q<HTMLButtonElement>('#start').disabled ? this.q('#leave') : this.q('#start')).focus();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.events.abort();
    this.audio.dispose();
    this.scene.dispose();
    this.elements.clear();
  }
}
