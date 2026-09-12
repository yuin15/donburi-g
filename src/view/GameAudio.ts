type Cue = 'spin' | 'choose' | 'win' | 'rivalWin' | 'jackpot' | 'lead' | 'warning' | 'result';

// Original synthesized cabinet sounds; no samples or recorded voices.
const NOTES: Record<Exclude<Cue, 'spin' | 'jackpot'>, number[]> = {
  choose: [660], win: [784, 1047, 1319], rivalWin: [523, 659],
  lead: [523, 784, 1047], warning: [880, 660, 880], result: [523, 659, 784, 1047],
};

export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private nodes = new Set<OscillatorNode>();

  async unlock(): Promise<void> {
    try {
      this.context ??= new AudioContext();
      if (!this.master) {
        this.master = this.context.createGain();
        this.master.gain.value = this.muted ? 0 : 0.035;
        this.master.connect(this.context.destination);
      }
      await this.context.resume();
    } catch { /* Audio restrictions must not block the match. */ }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.035;
    if (muted) this.stop();
  }

  play(cue: Cue): void {
    if (cue === 'spin') {
      // A low button thump followed by the reel ratchet accelerating.
      this.note(95, 0, .085, 1, 'triangle');
      [0, .09, .17, .24, .30, .35].forEach((delay, index) => {
        this.note(340 + index * 34, delay, .025, .32, 'square');
      });
      return;
    }
    if (cue === 'jackpot') {
      // Quick ascending fanfare, then a ringing major chord and coin chimes.
      [523, 659, 784, 1047, 1319, 1568, 2093].forEach((pitch, index) => {
        this.note(pitch, index * .065, .24, .8, 'triangle');
        this.note(pitch * 2, index * .065, .13, .14);
      });
      [523, 659, 784].forEach(pitch => this.note(pitch, .48, .64, .55, 'triangle'));
      [2093, 2637, 3136].forEach((pitch, index) => this.note(pitch, .66 + index * .11, .25, .35));
      return;
    }
    NOTES[cue].forEach((pitch, index) => {
      this.note(pitch, index * .085, cue === 'choose' ? .1 : .24, cue === 'rivalWin' ? .55 : .8, cue === 'choose' ? 'sine' : 'triangle');
      if (cue === 'win' || cue === 'result') this.note(pitch * 2, index * .085, .18, .18);
    });
  }

  countdownTick(seconds: number, voiceActive: boolean): void {
    this.note(620 + (6 - seconds) * 90, 0, .06, voiceActive ? .3 : .6, 'triangle');
  }

  /** The renderer calls this as each visible column locks into place. */
  reelStop(side: 'player' | 'rival', column: number): void {
    const volume = side === 'player' ? 1 : .36;
    this.note(135 + column * 32, 0, .065, volume, 'triangle');
    this.note(920 + column * 180, 0, .022, volume * .36, 'square');
  }

  private note(frequency: number, delay: number, duration: number, volume: number, type: OscillatorType = 'sine'): void {
    const context = this.context;
    if (!context || context.state !== 'running' || !this.master || this.muted) return;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const start = context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(volume, start + .004);
    envelope.gain.exponentialRampToValueAtTime(.001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    this.nodes.add(oscillator);
    oscillator.onended = () => {
      this.nodes.delete(oscillator);
      oscillator.disconnect();
      envelope.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(start + duration + .01);
  }

  stop(): void {
    for (const oscillator of this.nodes) oscillator.stop();
    this.nodes.clear();
  }

  dispose(): void {
    this.stop();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
  }
}
