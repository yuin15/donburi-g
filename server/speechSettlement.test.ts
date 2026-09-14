import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechSettlementQueue, transcribeForwardedPcm, retrySettlement } from './speechSettlement';

vi.mock('./env', () => ({ env: { openaiKey: 'synthetic-key' } }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('post-speech settlement transport', () => {
  it('retries a transient ASR error with the exact in-memory WAV and current transcription model', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ text: 'synthetic recovered acceptance' }));
    vi.stubGlobal('fetch', request);
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
    await expect(transcribeForwardedPcm(pcm, new AbortController().signal)).resolves.toBe('synthetic recovered acceptance');
    expect(request).toHaveBeenCalledTimes(2);
    for (const [url, init] of request.mock.calls) {
      expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
      const form = init.body as FormData;
      expect(form.get('model')).toBe('gpt-transcribe');
      const bytes = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(bytes.readUInt32LE(24)).toBe(24_000);
      expect(bytes.readUInt16LE(22)).toBe(1);
      expect(bytes.readUInt16LE(34)).toBe(16);
      expect(bytes.subarray(44)).toEqual(pcm);
    }
  });

  it('reports ASR exhaustion instead of treating unavailable or empty text as none', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ text: '' }));
    vi.stubGlobal('fetch', request);
    await expect(transcribeForwardedPcm(Buffer.alloc(48), new AbortController().signal)).rejects.toMatchObject({ stage: 'asr' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('bounds a non-cooperating transport and aborts every retry attempt', async () => {
    vi.useFakeTimers();
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const controller = new AbortController();
    const result = retrySettlement(request, () => false, controller.signal, 'asr');
    const check = expect(result).rejects.toMatchObject({ stage: 'asr' });
    await vi.advanceTimersByTimeAsync(16_000);
    await check;
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves chronological reservations and explicitly exhausts an unsealed long utterance', async () => {
    vi.useFakeTimers();
    const failed = vi.fn(); const settled = vi.fn(); const first = vi.fn(async () => undefined); const next = vi.fn(async () => undefined);
    const queue = new SpeechSettlementQueue(failed, settled);
    queue.reserve(first); // missing completion cannot hang a match forever
    queue.reserve(next)();
    await vi.advanceTimersByTimeAsync(34_999);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledWith('deadline');
    expect(queue.pending).toBe(false);
    queue.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
