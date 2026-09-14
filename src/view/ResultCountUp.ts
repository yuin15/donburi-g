type Side = 'player' | 'rival';
type Amounts = Readonly<Record<Side, number>>;
type ActiveRun = { player: HTMLElement; rival: HTMLElement; amounts: Amounts; startedAt: number | null };

const DURATION = 1800;
const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export class ResultCountUp {
  private active: ActiveRun | null = null;
  private frameId: number | null = null;
  private documentRef: Document | null = null;
  private mediaQuery: MediaQueryList | null = null;
  private disposed = false;

  private readonly onVisibilityChange = (): void => { if (this.documentRef?.hidden) this.stop(); };
  private readonly onMediaChange = (event: MediaQueryListEvent): void => { if (event.matches) this.stop(); };

  start(player: HTMLElement, rival: HTMLElement, amounts: Amounts): void {
    if (this.disposed) return;
    this.stop();
    this.attachListeners();
    const active: ActiveRun = { player, rival, amounts, startedAt: null };
    this.active = active;
    this.setLabels(active);
    if (this.shouldSkip()) { this.finish(); return; }
    this.render(active, 0);
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') { this.finish(); return; }
    const frame = (timestamp: number): void => {
      if (this.active !== active || this.disposed) return;
      this.frameId = null;
      active.startedAt ??= timestamp;
      const linear = Math.min(1, Math.max(0, (timestamp - active.startedAt) / DURATION));
      this.render(active, 1 - (1 - linear) ** 3);
      if (linear >= 1) this.finish();
      else this.frameId = raf(frame);
    };
    this.frameId = raf(frame);
  }

  stop(): void { if (this.active) this.finish(); else this.cancelFrame(); }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.documentRef?.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.mediaQuery) {
      if (this.mediaQuery.removeEventListener) this.mediaQuery.removeEventListener('change', this.onMediaChange);
      else this.mediaQuery.removeListener?.(this.onMediaChange);
    }
    this.documentRef = null;
    this.mediaQuery = null;
    this.disposed = true;
  }

  private finish(): void {
    const active = this.active;
    if (!active) return;
    this.cancelFrame();
    this.render(active, 1);
    this.active = null;
  }

  private cancelFrame(): void {
    if (this.frameId !== null && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  private attachListeners(): void {
    if (this.documentRef || typeof document === 'undefined') return;
    this.documentRef = document;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    if (typeof globalThis.matchMedia !== 'function') return;
    this.mediaQuery = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    if (this.mediaQuery.addEventListener) this.mediaQuery.addEventListener('change', this.onMediaChange);
    else this.mediaQuery.addListener?.(this.onMediaChange);
  }

  private shouldSkip(): boolean { return !!this.documentRef?.hidden || !!this.mediaQuery?.matches; }

  private setLabels(active: ActiveRun): void {
    active.player.setAttribute('aria-label', CURRENCY.format(active.amounts.player));
    active.rival.setAttribute('aria-label', CURRENCY.format(active.amounts.rival));
  }

  private render(active: ActiveRun, progress: number): void {
    this.setText(active.player, CURRENCY.format(Math.round(active.amounts.player * progress)));
    this.setText(active.rival, CURRENCY.format(Math.round(active.amounts.rival * progress)));
  }

  private setText(element: HTMLElement, value: string): void { if (element.textContent !== value) element.textContent = value; }
}
