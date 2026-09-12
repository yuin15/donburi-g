import type { Room } from 'livekit-client';
import type { ClientMessage, ServerMessage, VoiceMode } from '../../shared/protocol';
import { parseServerEnvelope } from '../../shared/wire';
import { LiveSync } from './LiveSync';
import { LiveAudioPlayer } from './LiveAudioPlayer';
import { MicrophoneInput, type MicrophoneFeedback } from './MicrophoneInput';

export class LiveClient extends EventTarget {
  private ws: WebSocket | null = null;
  private room: Room | null = null;
  private mic = new MicrophoneInput(state => this.dispatchEvent(new CustomEvent<MicrophoneFeedback>('microphone', { detail: state })), () => this.microphoneUnavailable());
  private pcm = new LiveAudioPlayer();
  private audioElement = document.createElement('audio');
  private abort = new AbortController();
  private closed = false;
  private connecting: Promise<void> | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private cleanup: Promise<void> | null = null;
  private connected = false;
  private voiceStopped = false;
  private voiceCleanup: Promise<void> | null = null;
  private microphoneStopped = false;
  private microphoneCleanup: Promise<void> | null = null;
  private sync = new LiveSync();
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly videoElement: HTMLVideoElement) {
    super();
    this.audioElement.autoplay = true;
  }

  connect(inviteCode: string, voiceMode: VoiceMode = 'avatar'): Promise<void> {
    this.connecting ??= this.prepareConnection(inviteCode, voiceMode).catch(async (error: unknown) => {
      await this.disconnect();
      throw error;
    });
    return this.connecting;
  }

  private async prepareConnection(inviteCode: string, voiceMode: VoiceMode): Promise<void> {
    if (this.closed) throw new Error('connection_cancelled');
    await this.mic.prepare();
    if (this.closed) throw new Error('connection_cancelled');
    if (voiceMode === 'audio') await this.pcm.prepare();
    if (this.closed) throw new Error('connection_cancelled');
    const response = await fetch('/api/access', {
      method: 'POST',
      headers: { 'X-Invite-Code': inviteCode, 'X-Voice-Mode': voiceMode },
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error('access_denied');
    const body = (await response.json()) as { ticket?: string };
    if (!body.ticket) throw new Error('missing_ticket');
    if (this.closed) throw new Error('connection_cancelled');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/api/ws?ticket=${encodeURIComponent(body.ticket)}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      let microphoneReady = false;
      let avatarReady = voiceMode === 'audio';
      let voiceReady = false;
      const timeout = setTimeout(() => fail(new Error('connection_timeout')), 30_000);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        this.rejectConnect = null;
        reject(error);
        if (!this.closed) {
          this.dispatchEvent(new Event('disconnect'));
          void this.disconnect();
        }
      };
      this.rejectConnect = (error) => { clearTimeout(timeout); reject(error); };
      const ready = () => {
        if (this.closed || this.connected || this.voiceStopped || !microphoneReady || !avatarReady || !voiceReady) return;
        this.connected = true;
        clearTimeout(timeout);
        this.rejectConnect = null;
        this.dispatchEvent(new CustomEvent<ServerMessage>('message', {
          detail: { type: 'voice_status', status: 'ready' },
        }));
        resolve();
      };
      ws.onopen = () => {
        if (this.closed) return;
        void this.mic.start((audio) => this.send({ type: 'mic', audio })).then(() => {
          microphoneReady = true;
          ready();
        }).catch(() => fail(new Error('microphone_start_failed')));
      };
      ws.onmessage = (event) => {
        if (this.closed) return;
        const wire = parseServerEnvelope(String(event.data));
        if (!wire) { fail(new Error('invalid_server_message')); return; }
        let synchronized: ReturnType<LiveSync['accept']>;
        try { synchronized = this.sync.accept(wire); } catch { fail(new Error('invalid_match_sequence')); return; }
        // Stop capture even if a sequence gap holds the result until its snapshot is recovered.
        if ((wire.type === 'snapshot' || wire.type === 'match_ended') && wire.snapshot.status === 'result') {
          void this.stopMicrophone();
        }
        if (synchronized.requestSnapshot) {
          this.pcm.interrupt();
          this.send({ type: 'snapshot' });
          this.syncTimeout = setTimeout(() => fail(new Error('snapshot_timeout')), 5000);
        }
        const message = synchronized.message;
        if (!message) return;
        if (message.type === 'snapshot' && this.syncTimeout) { clearTimeout(this.syncTimeout); this.syncTimeout = null; }
        if (message.type === 'voice_audio' || message.type === 'voice_interrupt') {
          if (!this.voiceStopped && voiceMode === 'audio') {
            try {
              if (message.type === 'voice_interrupt') this.pcm.interrupt();
              else this.pcm.play(message.audio);
            } catch {
              void this.stopVoice();
              this.dispatchEvent(new CustomEvent<ServerMessage>('message', {
                detail: { type: 'voice_status', status: 'error', message: 'Voice playback stopped. Your duel continues.' },
              }));
            }
          }
          if (message.type === 'voice_interrupt' && !this.voiceStopped) {
            this.dispatchEvent(new CustomEvent<ServerMessage>('message', { detail: message }));
          }
          return;
        }
        if (message.type === 'avatar' && !this.voiceStopped && voiceMode === 'avatar') {
          void this.attachAvatar(message.livekitUrl, message.livekitToken).then(() => {
            avatarReady = true;
            ready();
          }).catch(() => fail(new Error('avatar_connect_failed')));
        }
        if (message.type === 'voice_status' && message.status === 'ready') {
          if (this.voiceStopped) return;
          voiceReady = true;
          ready();
          return;
        }
        if (message.type === 'voice_status' && (message.status === 'error' || message.status === 'closed')) {
          if (!this.connected) { fail(new Error('voice_connect_failed')); return; }
          void this.stopVoice();
        }
        this.dispatchEvent(new CustomEvent<ServerMessage>('message', { detail: message }));
        if (message.type === 'error' && !message.recoverable) fail(new Error('session_failed'));
      };
      ws.onclose = () => {
        if (!this.closed) fail(new Error('socket_closed'));
      };
      ws.onerror = () => fail(new Error('socket_error'));
    });
  }

  send(message: ClientMessage): void {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    if (message.type === 'mic' && this.microphoneStopped) return;
    const payload = message.type === 'upgrade' ? { ...message, matchId: this.sync.sessionId } : message;
    this.ws.send(JSON.stringify(payload));
  }

  sendSpin(): string | undefined {
    if (!this.connected || this.closed || this.ws?.readyState !== WebSocket.OPEN || !this.sync.sessionId) return;
    const commandId = crypto.randomUUID();
    try {
      this.send({ type: 'spin', commandId, matchId: this.sync.sessionId });
      return commandId;
    } catch { return undefined; }
  }

  setMicMuted(muted: boolean): void { this.mic.setMuted(muted); }

  private microphoneUnavailable(): void {
    if (this.closed || this.voiceStopped) return;
    if (!this.connected) { void this.disconnect(); return; }
    void this.stopVoice();
    this.dispatchEvent(new CustomEvent<ServerMessage>('message', {
      detail: { type: 'voice_status', status: 'error', message: 'Microphone disconnected · Your duel continues.' },
    }));
  }

  setMuted(muted: boolean): void {
    this.audioElement.muted = muted;
    this.pcm.setMuted(muted);
  }

  disconnect(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'close' });
    this.closed = true;
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = null;
    this.abort.abort();
    this.rejectConnect?.(new Error('connection_cancelled'));
    this.rejectConnect = null;
    this.ws?.close();
    this.ws = null;
    this.cleanup = this.stopVoice();
    return this.cleanup;
  }

  private stopMicrophone(): Promise<void> {
    this.microphoneStopped = true;
    this.microphoneCleanup ??= this.mic.stop();
    return this.microphoneCleanup;
  }

  private stopVoice(): Promise<void> {
    if (this.voiceCleanup) return this.voiceCleanup;
    this.voiceStopped = true;
    this.send({ type: 'voice_close' });
    this.voiceCleanup = Promise.allSettled([this.stopMicrophone(), this.detachAvatar(), this.pcm.close()]).then(() => undefined);
    return this.voiceCleanup;
  }

  private async attachAvatar(url: string, token: string): Promise<void> {
    await this.detachAvatar();
    if (this.closed || this.voiceStopped) throw new Error('connection_cancelled');
    const { Room, RoomEvent } = await import('livekit-client');
    if (this.closed || this.voiceStopped) throw new Error('connection_cancelled');
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (this.closed || this.voiceStopped || this.room !== room) return;
      if (track.kind === 'video') track.attach(this.videoElement);
      if (track.kind === 'audio') track.attach(this.audioElement);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.closed || this.room !== room) return;
      if (!this.connected) {
        this.rejectConnect?.(new Error('avatar_connect_failed'));
        void this.disconnect();
        return;
      }
      void this.stopVoice();
      this.dispatchEvent(new CustomEvent<ServerMessage>('message', {
        detail: { type: 'voice_status', status: 'error', message: 'Voice disconnected · Your duel continues.' },
      }));
    });
    await room.connect(url, token);
    if (this.closed || this.room !== room) {
      await room.disconnect();
      throw new Error('connection_cancelled');
    }
  }

  private async detachAvatar(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.videoElement.srcObject = null;
    this.audioElement.srcObject = null;
    await room?.disconnect();
  }
}
