import { Room, RoomEvent } from 'livekit-client';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function downsamplePcm16(input: Float32Array, inputRate: number, outputRate = 24000): ArrayBuffer {
  if (outputRate > inputRate) throw new Error('unsupported_sample_rate');
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

class MicrophonePump {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;

  async prepare(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone_unavailable');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  }

  async start(send: (audio: string) => void): Promise<void> {
    if (!this.stream) throw new Error('microphone_not_prepared');
    this.context = new AudioContext();
    await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      const pcm = downsamplePcm16(channel, this.context?.sampleRate ?? 48000);
      send(arrayBufferToBase64(pcm));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close().catch(() => undefined);
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
  }
}

export class LiveClient extends EventTarget {
  private ws: WebSocket | null = null;
  private room: Room | null = null;
  private mic = new MicrophonePump();
  private audioElement = document.createElement('audio');
  private connected = false;
  private intentionallyClosed = false;

  constructor(private readonly videoElement: HTMLVideoElement) {
    super();
    this.audioElement.autoplay = true;
    this.audioElement.playsInline = true;
  }

  async connect(inviteCode: string): Promise<void> {
    if (this.connected || this.ws) return;
    this.intentionallyClosed = false;
    await this.mic.prepare();
    let ticket = '';
    try {
      const response = await fetch('/api/access', {
        method: 'POST',
        headers: { 'X-Invite-Code': inviteCode },
      });
      if (!response.ok) throw new Error('access_denied');
      const body = (await response.json()) as { ticket?: string };
      ticket = body.ticket ?? '';
      if (!ticket) throw new Error('missing_ticket');
    } catch (error) {
      await this.mic.stop();
      throw error;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('socket_timeout')), 12_000);
      ws.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        void this.mic.start((audio) => this.send({ type: 'mic', audio }));
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('socket_error'));
      };
    }).catch(async (error) => {
      await this.disconnect();
      throw error;
    });

    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'avatar') void this.attachAvatar(message.livekitUrl, message.livekitToken);
      this.dispatchEvent(new CustomEvent<ServerMessage>('message', { detail: message }));
    };
    ws.onclose = () => {
      this.connected = false;
      if (!this.intentionallyClosed) this.dispatchEvent(new Event('disconnect'));
      void this.mic.stop();
      void this.detachAvatar();
    };
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  setMuted(muted: boolean): void {
    this.audioElement.muted = muted;
  }

  async disconnect(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'close' });
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    await this.mic.stop();
    await this.detachAvatar();
  }

  private async attachAvatar(url: string, token: string): Promise<void> {
    await this.detachAvatar();
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'video') track.attach(this.videoElement);
      if (track.kind === 'audio') track.attach(this.audioElement);
    });
    room.on(RoomEvent.Disconnected, () => this.dispatchEvent(new Event('avatar-disconnect')));
    await room.connect(url, token);
  }

  private async detachAvatar(): Promise<void> {
    if (this.room) {
      this.room.disconnect();
      this.room = null;
    }
    this.videoElement.srcObject = null;
    this.audioElement.srcObject = null;
  }
}
