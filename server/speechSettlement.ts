import { env } from './env.js';

export class SettlementUnavailable extends Error {
  constructor(readonly stage: 'asr' | 'classification' | 'deadline') { super(stage); }
}

/** Bound even a transport that ignores AbortSignal; never leave background rejections unhandled. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw signal.reason;
  }
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function retrySettlement<T>(
  request: (signal: AbortSignal) => Promise<T>,
  unavailable: (result: T) => boolean,
  signal: AbortSignal,
  stage: 'asr' | 'classification',
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), stage === 'asr' ? 8_000 : 6_000);
    try {
      const combined = AbortSignal.any([signal, timeout.signal]);
      const result = await abortable(request(combined), combined);
      signal.throwIfAborted();
      if (!unavailable(result)) return result;
    } catch {
      signal.throwIfAborted();
    } finally { clearTimeout(timer); }
  }
  throw new SettlementUnavailable(stage);
}

/** The exact forwarded 24kHz PCM16 mono bytes, wrapped in an in-memory WAV. */
export function pcmWave(pcm: Buffer): Uint8Array<ArrayBuffer> {
  const wave = Buffer.alloc(44 + pcm.length);
  wave.write('RIFF'); wave.writeUInt32LE(36 + pcm.length, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(24_000, 24); wave.writeUInt32LE(48_000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40); pcm.copy(wave, 44);
  return new Uint8Array(wave);
}

export async function transcribeForwardedPcm(pcm: Buffer, signal: AbortSignal): Promise<string> {
  return retrySettlement(async attemptSignal => {
    const form = new FormData();
    form.append('model', 'gpt-transcribe');
    form.append('response_format', 'json');
    form.append('file', new Blob([pcmWave(pcm)], { type: 'audio/wav' }), 'speech.wav');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${env.openaiKey}` }, body: form, signal: attemptSignal,
    });
    if (!response.ok) throw new SettlementUnavailable('asr');
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string' || !result.text.trim()) {
      throw new SettlementUnavailable('asr');
    }
    return result.text;
  }, () => false, signal, 'asr');
}

/** Chronological reservations preserve a heard offer before a fast user yes. */
export class SpeechSettlementQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly entries = new Set<AbortController>();
  private closed = false;

  constructor(private readonly onFailure: (stage: string) => void, private readonly onSettled: () => void) {}
  get pending(): boolean { return this.entries.size > 0; }

  reserve(work: (signal: AbortSignal) => Promise<void>, onFinished?: () => void): () => void {
    if (this.closed) return () => undefined;
    const controller = new AbortController();
    this.entries.add(controller);
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    // Includes queue wait and audio/transcript collection, not just network time.
    const timer = setTimeout(() => controller.abort(new SettlementUnavailable('deadline')), 35_000);
    this.tail = this.tail.then(async () => {
      await abortable(ready, controller.signal);
      await abortable(work(controller.signal), controller.signal);
    }).catch(error => {
      if (!this.closed) this.onFailure(error instanceof SettlementUnavailable ? error.stage : 'classification');
    }).finally(() => {
      clearTimeout(timer);
      this.entries.delete(controller);
      onFinished?.();
      if (!this.closed) this.onSettled();
    });
    return release;
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries) entry.abort();
    this.entries.clear();
  }
}
