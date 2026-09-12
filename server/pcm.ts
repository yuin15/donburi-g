/** PCM16, 24 kHz mono. Inspect amplitude without retaining or transcribing audio. */
export function pcmRms(pcm: Buffer): number {
  if (!pcm.length || pcm.length % 2) return 0;
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(energy / (pcm.length / 2));
}

/** Adapt a continuous model stream to the avatar's finite utterances. */
export class AvatarAudioBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private quietMs = 0;
  private active = false;
  private preRoll = Buffer.alloc(0);
  private deadline: NodeJS.Timeout | null = null;

  constructor(private readonly send: (audio: string) => void, private readonly end: () => void) {}

  append(audio: string): void {
    const pcm = Buffer.from(audio, 'base64');
    if (!pcm.length || pcm.length % 2) return;
    const audible = pcmRms(pcm) > 32;
    if (!this.active) {
      if (!audible) {
        // Keep just 100 ms before the onset, never the whole idle period.
        this.preRoll = pcm.subarray(Math.max(0, pcm.length - 4800));
        return;
      }
      this.active = true;
      if (this.preRoll.length) this.add(this.preRoll);
      this.preRoll = Buffer.alloc(0);
    }
    this.add(pcm);
    this.quietMs = audible ? 0 : this.quietMs + pcm.length / 48;
    if (this.deadline) clearTimeout(this.deadline);
    if (this.quietMs >= 300) {
      this.finish();
      return;
    }
    // Short initial buffering, with bounded chunks instead of one command per frame.
    if (this.bytes >= 19_200) this.flush();
    this.deadline = setTimeout(() => this.finish(), 500);
  }

  reset(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    this.chunks = [];
    this.bytes = 0;
    this.quietMs = 0;
    this.active = false;
    this.preRoll = Buffer.alloc(0);
  }

  private add(pcm: Buffer): void {
    this.chunks.push(pcm);
    this.bytes += pcm.length;
  }

  private flush(): void {
    if (!this.bytes) return;
    const audio = Buffer.concat(this.chunks, this.bytes).toString('base64');
    this.chunks = [];
    this.bytes = 0;
    this.send(audio);
  }

  private finish(): void {
    if (!this.active) return;
    this.flush();
    this.end();
    this.reset();
  }
}
