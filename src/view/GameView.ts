import type { MatchSnapshot, SpinView, UpgradeId } from '../../shared/protocol';
import { PAYOUT, UPGRADE_DEFINITIONS } from '../domain/game';
import { describePool } from '../domain/upgradePreview';
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
  private beforeUpgradeFocus: HTMLElement | null = null;
  private oddsKey = '';
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
    this.scene = new ReelScene(this.q('#stageArt'));
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
      void commands.connectLive(code).then(() => { if (!this.current?.gate.visible) input.value = ''; });
    }, options);
    this.q('#leave').addEventListener('click', () => commands.leave(), options);
    this.q('#sound').addEventListener('click', () => commands.toggleVoiceMuted(), options);
    this.q('#effects').addEventListener('click', () => { unlock(); commands.toggleEffectsMuted(); }, options);
    this.q('#upgrade').addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-up]');
      if (!button || button.disabled) return;
      unlock();
      commands.chooseUpgrade(button.dataset.up as UpgradeId);
    }, options);
    addEventListener('keydown', event => {
      const state = this.current;
      if (!state || state.gate.visible) return;
      if (event.code === 'Space' && state.snapshot.status === 'playing') {
        const control = event.target instanceof Element ? event.target.closest('input,textarea,select,summary,button') : null;
        if (control && control !== this.q('#start')) return;
        event.preventDefault();
        if (!event.repeat) { unlock(); commands.requestSpin(); }
        return;
      }
      if (state.upgrade?.phase !== 'open' || (event.key !== '1' && event.key !== '2')) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select')) return;
      if (state.upgrade.choice) return;
      unlock();
      commands.chooseUpgrade(event.key === '1' ? 'steady' : 'jackpot');
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
    this.video.hidden = !state.connection.voiceReady;
    this.q('#mockFace').hidden = state.connection.voiceReady;
    this.q('#sound').hidden = !state.connection.showVoiceControls;
    this.text('#sound', state.voiceMuted ? 'AI音声 OFF' : 'AI音声 ON');
    this.q('#sound').setAttribute('aria-label', state.voiceMuted ? 'AI音声のミュートを解除' : 'AI音声をミュート');
    this.q('#sound').setAttribute('aria-pressed', String(state.voiceMuted));
    this.text('#effects', state.effectsMuted ? '効果音 OFF' : '効果音 ON');
    this.q('#effects').setAttribute('aria-label', state.effectsMuted ? '効果音のミュートを解除' : '効果音をミュート');
    this.q('#effects').setAttribute('aria-pressed', String(state.effectsMuted));

    const snapshot = state.snapshot;
    this.scene.setUpgrades(snapshot.upgrades.player, snapshot.upgrades.rival);
    this.scene.setExpression(state.expression);
    this.text('#time', String(Math.max(0, Math.ceil(snapshot.remaining))).padStart(2, '0'));
    this.q('#timer').classList.toggle('urgent', snapshot.status === 'playing' && snapshot.remaining <= 10);
    this.text('#ps', state.scores.player.toLocaleString());
    this.text('#rs', state.scores.rival.toLocaleString());
    const total = state.scores.player + state.scores.rival;
    const gap = state.scores.player - state.scores.rival;
    this.q('#playerMeter').style.width = `${total ? state.scores.player / total * 100 : 50}%`;
    this.q('#rivalMeter').style.width = `${total ? state.scores.rival / total * 100 : 50}%`;
    this.text('#scoreGap', gap === 0 ? '互角の勝負' : `${Math.abs(gap).toLocaleString()}点 ${gap > 0 ? 'リード' : 'ビハインド'}`);
    this.q('#scoreGap').dataset.leader = gap > 0 ? 'player' : gap < 0 ? 'rival' : 'draw';
    this.text('#rivalMood', state.rivalMood);
    this.text('#line', state.line);
    this.text('#heard', state.heard);
    this.text('#machineTrim', state.machineNotice);
    this.text('#upgradeProgress', state.upgradeProgress);
    this.renderBuild('player', snapshot.upgrades.player);
    this.renderBuild('rival', snapshot.upgrades.rival);
    this.text('#rivalUpgradeNote', state.rivalUpgradeNotice);
    this.q('#rivalUpgradeNote').hidden = !state.rivalUpgradeNotice;
    this.q('#rivalBuild').hidden = Boolean(state.rivalUpgradeNotice);
    this.text('#lastSpin', state.lastSpin ? this.glyphs(state.lastSpin.player) : 'チェリー・ベル・7');
    this.text('#rivalReels', state.lastSpin ? this.glyphs(state.lastSpin.rival) : 'チェリー・ベル・7');

    this.text('#pay', state.payout?.player ? `+${state.payout.player.toLocaleString()}` : '');
    this.q('#pay').dataset.jackpot = String((state.payout?.player ?? 0) >= PAYOUT.seven);
    this.text('#rivalPay', state.payout?.rival ? `+${state.payout.rival.toLocaleString()}` : '');
    this.q('#rivalPay').dataset.jackpot = String((state.payout?.rival ?? 0) >= PAYOUT.seven);
    this.q('#rivalPay').hidden = !state.payout?.rival;
    this.q('#eventCue').hidden = !state.cue;
    if (state.cue) {
      this.text('#eventCue', state.cue.text);
      this.q('#eventCue').dataset.kind = state.cue.kind;
    }
    const start = this.q<HTMLButtonElement>('#start');
    start.disabled = state.startControl.disabled;
    this.text('#start', state.startControl.label);
    if (state.startControl.spinState) start.dataset.spin = state.startControl.spinState;
    else delete start.dataset.spin;
    this.text('#spinHint', state.startControl.hint);
    this.renderUpgrade(state, previous);
    this.renderResult(state.result);
    this.q('#countdown').hidden = state.countdown === null;
    if (state.countdown !== null) {
      this.text('#countdown', String(state.countdown));
      if (previous?.countdown === null) this.q('#leave').focus();
    }
  }

  private glyphs(spin: SpinView): string {
    const glyph = { cherry: 'チェリー', bell: 'ベル', seven: '7' };
    return spin.symbols.map(symbol => glyph[symbol]).join('　');
  }

  private renderBuild(side: 'player' | 'rival', upgrades: readonly UpgradeId[]): void {
    const row = this.q('#' + side + 'BuildRow');
    const key = upgrades.join(',');
    if (row.dataset.build === key) return;
    row.dataset.build = key;
    row.dataset.upgraded = String(upgrades.length);
    this.text('#' + side + 'Build', upgrades.length ? upgrades.map(id => UPGRADE_DEFINITIONS[id].label).join(' / ') : '基本リール');
    const { counts, total } = describePool(upgrades);
    const strip = this.q('#' + side + 'Strip');
    strip.setAttribute('aria-label', `絵柄${total}枚：チェリー${counts.cherry}枚、ベル${counts.bell}枚、7が${counts.seven}枚`);
    strip.replaceChildren();
    for (const symbol of ['cherry', 'bell', 'seven'] as const) {
      const segment = document.createElement('span');
      segment.className = 'build-segment ' + symbol;
      segment.style.flexGrow = String(counts[symbol]);
      segment.setAttribute('aria-hidden', 'true');
      const icon = document.createElement('i');
      icon.className = 'symbol-icon ' + symbol;
      const count = document.createElement('b');
      count.textContent = String(counts[symbol]);
      segment.append(icon, count);
      strip.append(segment);
    }
  }

  private renderUpgrade(state: GameViewState, previous: GameViewState | null): void {
    const panel = this.q('#upgrade');
    const upgrade = state.upgrade;
    if (!upgrade) {
      const restore = panel.contains(document.activeElement);
      panel.hidden = true;
      this.q('.shell').dataset.upgrading = 'false';
      this.oddsKey = '';
      if (restore) {
        const before = this.beforeUpgradeFocus;
        if (before?.isConnected && !before.matches(':disabled') && !before.closest('[inert], [hidden]')) before.focus();
        else this.focus('start');
      }
      this.beforeUpgradeFocus = null;
      return;
    }
    if (upgrade.phase === 'open' && (previous?.upgrade?.phase !== 'open' || previous.upgrade.index !== upgrade.index)) {
      this.beforeUpgradeFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    panel.hidden = false;
    panel.dataset.phase = upgrade.phase;
    this.q('.shell').dataset.upgrading = 'true';
    this.text('#upgradeTitle', upgrade.phase === 'preview' ? '改造プレビュー' : 'リール改造');
    this.text('#upgradeNo', `UPGRADE ${upgrade.index + 1} / 2`);
    this.text('#upgradeChoice', upgrade.choiceText);
    this.text('#upgradeRemain', upgrade.phase === 'preview' ? `選択まで ${Math.ceil(upgrade.remainingSeconds)}秒` : `残り ${Math.max(0, upgrade.remainingSeconds).toFixed(1)}秒`);
    this.q('#upgradeClockFill').style.transform = `scaleX(${Math.max(0, Math.min(1, upgrade.progress))})`;
    panel.querySelectorAll<HTMLButtonElement>('button[data-up]').forEach(button => {
      button.disabled = upgrade.phase === 'preview' || upgrade.choice !== null;
      button.setAttribute('aria-pressed', String(upgrade.choice === button.dataset.up));
    });
    const key = JSON.stringify(upgrade.options);
    if (key !== this.oddsKey) {
      this.oddsKey = key;
      const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
      for (const id of ['steady', 'jackpot'] as const) {
        const { before, after } = upgrade.options[id];
        const odds = this.q('#' + id + 'Odds');
        odds.replaceChildren();
        for (const [label, from, to] of [['当たり率', before.hitChance, after.hitChance], ['7揃い', before.sevenChance, after.sevenChance]] as const) {
          const row = document.createElement('span');
          row.dataset.featured = String(id === 'steady' ? label === '当たり率' : label === '7揃い');
          const change = document.createElement('strong');
          const old = document.createElement('span');
          old.className = 'odds-before';
          old.textContent = `${percent(from)} → `;
          change.append(old, percent(to));
          row.append(`${label} `, change);
          odds.append(row);
        }
      }
    }
    // Opening this non-modal panel must never turn a queued Space into a choice.
    if (upgrade.choice && previous?.upgrade?.choice !== upgrade.choice) this.q('#upgradeChoice').focus();
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
    const key = `${snapshot.matchId}:${snapshot.round}:${snapshot.scores.player}:${snapshot.scores.rival}`;
    if (key === this.resultKey) return;
    this.resultKey = key;
    panel.dataset.outcome = snapshot.winner ?? 'draw';
    this.text('#resultRounds', `60 SECONDS · ${snapshot.round} SPINS`);
    this.q<HTMLDetailsElement>('#resultDetails').open = false;
    this.text('#resultEnglish', snapshot.winner === 'player' ? 'VICTORY' : snapshot.winner === 'rival' ? 'NEXT TIME' : 'DRAW');
    this.text('#resultTitle', snapshot.winner === 'player' ? '勝利！' : snapshot.winner === 'rival' ? '敗北' : '引き分け');
    this.text('#resultPlayer', snapshot.scores.player.toLocaleString());
    this.text('#resultRival', snapshot.scores.rival.toLocaleString());
    const margin = Math.abs(snapshot.scores.player - snapshot.scores.rival).toLocaleString();
    this.text('#resultGap', snapshot.winner === 'player' ? `${margin}コイン差で、ライバルを超えた。` : snapshot.winner === 'rival' ? `${margin}コイン差。次こそ、逆転を。` : '同じコイン数。決着は、次の60秒。');
    this.text('#resultAgain', snapshot.winner === 'player' ? 'もう一勝、狙いにいこう。' : '改造を変えて、もう一度。');
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
    for (const [symbol, label] of [['cherry', 'チェリー'], ['bell', 'ベル'], ['seven', '7']] as const) {
      const value = (side: 'player' | 'rival') => {
        const count = snapshot.stats[side].wins[symbol];
        return `${count}回 · ${(count * PAYOUT[symbol]).toLocaleString()}点`;
      };
      addRow(label, value('player'), value('rival'), symbol);
    }
    const best = (side: 'player' | 'rival') => {
      const spin = snapshot.stats[side].bestSpin;
      return spin ? `${spin.payout.toLocaleString()}点（${spin.round}回転目）` : '当たりなし';
    };
    addRow('最高の一回', best('player'), best('rival'));
    const build = (side: 'player' | 'rival') => snapshot.upgrades[side].map(id => UPGRADE_DEFINITIONS[id].label).join(' → ') || '未改造';
    addRow('改造の順番', build('player'), build('rival'));
  }

  playRound(player: SpinView, rival: SpinView, stopped: (celebrate?: boolean) => void): void {
    this.scene.setUpgrades(player.upgrades ?? this.current?.snapshot.upgrades.player ?? [], rival.upgrades ?? this.current?.snapshot.upgrades.rival ?? []);
    this.scene.play(player, rival, stopped);
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
