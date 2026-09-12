export interface MicrophoneFeedback { active: boolean; level: number }

function encodePcm(input: Float32Array, inputRate: number, muted: boolean): string {
  const ratio = inputRate / 24000;
  if (ratio < 1) throw new Error('unsupported_sample_rate');
  const output = new Int16Array(Math.max(1, Math.floor(input.length / ratio)));
  if (!muted) for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(output.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Owns microphone capture; publishes only a coarse level for the UI. */
export class MicrophoneInput {
  private stopped = false;
  private muted = false;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private meterSeconds = 0;
  private meterPeak = 0;
  private lastFeedback: MicrophoneFeedback = { active: false, level: 0 };

  constructor(private readonly feedback: (state: MicrophoneFeedback) => void, private readonly unavailable: () => void) {}

  async prepare(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone_unavailable');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
    if (this.stopped) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('connection_cancelled');
    }
    this.stream = stream;
    for (const track of stream.getTracks()) {
      track.enabled = !this.muted;
      track.addEventListener('ended', () => { if (!this.stopped) this.unavailable(); }, { once: true });
    }
  }

  async start(send: (audio: string) => void): Promise<void> {
    if (!this.stream) throw new Error('microphone_not_prepared');
    const context = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
    this.context = context;
    await context.resume();
    if (this.stopped || !this.stream) throw new Error('connection_cancelled');
    this.source = context.createMediaStreamSource(this.stream);
    this.processor = context.createScriptProcessor(1024, 1, 1);
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.processor.onaudioprocess = event => {
      const channel = event.inputBuffer.getChannelData(0);
      const rate = context.sampleRate ?? 48000;
      send(encodePcm(channel, rate, this.muted));
      // Sample on the audio clock, at most about eight UI updates per second.
      this.meterSeconds += channel.length / rate;
      if (!this.muted) {
        let energy = 0;
        for (const sample of channel) energy += sample * sample;
        this.meterPeak = Math.max(this.meterPeak, Math.sqrt(energy / channel.length));
      }
      if (this.meterSeconds >= 0.12) {
        const level = this.muted || this.meterPeak < 0.003 ? 0 : Math.min(5, Math.max(1, Math.ceil((20 * Math.log10(this.meterPeak) + 50) / 8)));
        this.publish(true, level);
        this.meterSeconds = this.meterPeak = 0;
      }
    };
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(context.destination);
    this.publish(true, 0);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.stream?.getTracks().forEach(track => { track.enabled = !muted; });
    this.meterSeconds = this.meterPeak = 0;
    this.publish(!!this.processor && !this.stopped, 0);
  }

  private publish(active: boolean, level: number): void {
    if (active === this.lastFeedback.active && level === this.lastFeedback.level) return;
    this.lastFeedback = { active, level };
    this.feedback(this.lastFeedback);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    const context = this.context;
    this.stream = this.context = this.source = this.processor = this.sink = null;
    this.meterSeconds = this.meterPeak = 0;
    this.publish(false, 0);
    await context?.close().catch(() => undefined);
  }
}
