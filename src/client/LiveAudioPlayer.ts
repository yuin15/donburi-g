/** Short PCM playback queue for GPT-Live without an avatar service. */
export class LiveAudioPlayer {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private muted = false;
  private closed = false;
  private readonly speechSources = new Map<string, Set<AudioBufferSourceNode>>();
  private readonly speechWaiters = new Map<string, Array<() => void>>();

  async prepare(): Promise<void> {
    if (this.closed) throw new Error('audio_cancelled');
    const context = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
    this.context = context;
    this.gain = context.createGain();
    this.gain.gain.value = this.muted ? 0 : 1;
    this.gain.connect(context.destination);
    await context.resume();
    if (this.closed || context.state !== 'running') throw new Error('audio_unavailable');
  }

  play(audio: string, speechId?: string): void {
    const context = this.context, gain = this.gain;
    if (this.closed || !context || !gain) return;
    const binary = atob(audio);
    if (!binary.length || binary.length % 2) return;
    const buffer = context.createBuffer(1, binary.length / 2, 24000);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const word = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
      samples[i] = (word >= 0x8000 ? word - 0x10000 : word) / 0x8000;
    }
    // A delayed network burst must not turn into several seconds of old speech.
    if (this.nextAt - context.currentTime > 0.75) this.interrupt();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => {
      this.sources.delete(source); source.disconnect();
      if (speechId) {
        const speech = this.speechSources.get(speechId);
        speech?.delete(source);
        if (!speech?.size) this.resolveSpeech(speechId);
      }
    };
    this.sources.add(source);
    if (speechId) {
      let speech = this.speechSources.get(speechId);
      if (!speech) {
        speech = new Set();
        this.speechSources.set(speechId, speech);
      }
      speech.add(source);
    }
    const at = Math.max(context.currentTime + 0.04, this.nextAt);
    source.start(at);
    this.nextAt = at + buffer.duration;
  }

  speechEnded(speechId: string): Promise<void> {
    if (!this.speechSources.get(speechId)?.size) return Promise.resolve();
    return new Promise(resolve => this.speechWaiters.set(speechId, [...(this.speechWaiters.get(speechId) ?? []), resolve]));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }

  interrupt(): void {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    for (const speechId of this.speechSources.keys()) this.resolveSpeech(speechId);
    this.speechSources.clear();
    this.nextAt = 0;
  }

  private resolveSpeech(speechId: string): void {
    this.speechSources.delete(speechId);
    for (const resolve of this.speechWaiters.get(speechId) ?? []) resolve();
    this.speechWaiters.delete(speechId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    this.gain?.disconnect();
    this.gain = null;
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => undefined);
  }
}
