type Cue = 'spin' | 'choose' | 'win' | 'bellWin' | 'rivalWin' | 'jackpot' | 'lead' | 'warning' | 'ruleChange' | 'result' | 'victory' | 'defeat' | 'draw';

// Original synthesized cabinet sounds; no samples or recorded voices.
const NOTES: Record<Exclude<Cue, 'spin' | 'win' | 'bellWin' | 'jackpot' | 'victory' | 'defeat' | 'draw'>, number[]> = {
  choose: [660], rivalWin: [523, 659],
  lead: [523, 784, 1047], warning: [880, 660, 880], ruleChange: [330, 494, 740, 988], result: [523, 659, 784, 1047],
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
    if (cue === 'win') {
      // Cherry win: a short low impact, then a compact collect at about .5s.
      this.note(156, 0, .11, .68, 'triangle');
      [784, 988, 1319].forEach((pitch, index) => {
        this.note(pitch, .035 + index * .075, .17, .54 - index * .06, 'triangle');
      });
      [1760, 2349, 3136].forEach((pitch, index) => {
        this.note(pitch, .42 + index * .055, .14, .16, 'sine');
      });
      return;
    }
    if (cue === 'bellWin') {
      // Bell win: a fuller phrase, with metallic chimes arriving from .65-.85s.
      this.note(220, 0, .15, .42, 'triangle');
      [659, 784, 988, 1319].forEach((pitch, index) => {
        this.note(pitch, .06 + index * .12, .22, .48, 'triangle');
      });
      [1976, 2489, 3136].forEach((pitch, index) => {
        const delay = .65 + index * .085;
        this.note(pitch, delay, .2, .18, 'sine');
        this.note(pitch * 2, delay + .008, .12, .055, 'sine');
      });
      return;
    }
    if (cue === 'jackpot') {
      // Jackpot: low impact at zero, an ascending lift, then four small collect waves.
      this.note(72, 0, .24, .86, 'triangle');
      this.note(108, .008, .2, .42, 'sawtooth');
      [220, 277, 330, 415, 494, 587, 659].forEach((pitch, index) => {
        this.note(pitch, .10 + index * .075, .19, .34, 'triangle');
      });
      [
        [1319, 1760, .70], [1568, 2093, .91], [1760, 2637, 1.12],
        [2093, 3136, 1.34], [2349, 3520, 1.55],
      ].forEach(([low, high, delay]) => {
        this.note(low, delay, .22, .18, 'sine');
        this.note(high, delay + .014, .17, .09, 'sine');
      });
      return;
    }
    if (cue === 'victory') {
      // Final match victory: bright launch, restrained coin rain, and a 2.2-2.8s resolution.
      this.note(110, 0, .24, .64, 'triangle');
      [523, 659, 784, 988, 1175, 1319, 1568].forEach((pitch, index) => {
        this.note(pitch, .08 + index * .075, .23, .40, 'triangle');
      });
      [784, 988, 1175].forEach((pitch, index) => {
        this.note(pitch, .70 + index * .06, .45, .19, 'sine');
      });
      // One oscillator per coin keeps the rain audible without a wall of chirps.
      [1760, 2093, 2349, 2637, 3136, 2349, 3520, 2637].forEach((pitch, index) => {
        this.note(pitch, .92 + index * .13, .14, .13, 'sine');
      });
      [1047, 1319, 1568].forEach((pitch, index) => {
        this.note(pitch, 2.22 + index * .08, .42, .30, 'triangle');
      });
      this.note(2093, 2.54, .30, .16, 'sine');
      return;
    }
    if (cue === 'defeat') {
      // A restrained descending phrase for a lost match.
      this.note(196, 0, .18, .34, 'triangle');
      [392, 330, 262, 196].forEach((pitch, index) => {
        this.note(pitch, .08 + index * .16, .23, .25, 'sine');
      });
      return;
    }
    if (cue === 'draw') {
      // A suspended, neutral cadence distinct from both victory and defeat.
      [440, 554, 494, 659].forEach((pitch, index) => {
        this.note(pitch, index * .16, .22, .22, 'sine');
      });
      return;
    }
    NOTES[cue].forEach((pitch, index) => {
      this.note(pitch, index * .085, cue === 'choose' ? .1 : .24, cue === 'rivalWin' ? .55 : .8, cue === 'choose' ? 'sine' : 'triangle');
      if (cue === 'result' || cue === 'ruleChange') this.note(pitch * 2, index * .085, .18, cue === 'ruleChange' ? .34 : .18);
    });
  }

  /** A short cabinet switch click for BET controls and their keyboard shortcuts. */
  betClick(): void {
    this.note(180, 0, .045, .52, 'triangle');
    this.note(620, .012, .024, .18, 'square');
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
