type Cue = 'spin' | 'choose' | 'win' | 'rivalWin' | 'jackpot' | 'lead' | 'warning' | 'result';

// Original synthesized cues: no downloaded samples or personal recordings.
const NOTES: Record<Cue, number[]> = {
  spin: [180, 240], choose: [660], win: [660, 880], rivalWin: [392, 330],
  jackpot: [523, 659, 784, 1047], lead: [440, 660, 880],
  warning: [880, 660, 880], result: [523, 659, 784],
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
    const context = this.context;
    if (!context || context.state !== 'running' || !this.master || this.muted) return;
    const duration = cue === 'spin' ? 0.055 : 0.1;
    NOTES[cue].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const start = context.currentTime + index * (duration + 0.025);
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(1, start + 0.008);
      envelope.gain.exponentialRampToValueAtTime(0.001, start + duration);
      oscillator.connect(envelope);
      envelope.connect(this.master!);
      this.nodes.add(oscillator);
      oscillator.onended = () => {
        this.nodes.delete(oscillator);
        oscillator.disconnect();
        envelope.disconnect();
      };
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    });
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
