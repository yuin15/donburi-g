import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class MediaServerLeg {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private readyResolve: ((value: boolean) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout | null = null;

  constructor(private readonly url: string) {}

  async start(timeoutMs = 15_000): Promise<boolean> {
    if (this.closed) return false;
    return await new Promise<boolean>((resolve) => {
      this.readyResolve = resolve;
      this.readyTimer = setTimeout(() => this.finishReady(false), timeoutMs);
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => {
        this.keepAlive = setInterval(() => {
          this.send({ type: 'session.keep_alive', event_id: randomUUID() });
        }, 120_000);
      });
      ws.on('message', (raw) => {
        let event: { type?: string; state?: string };
        try {
          event = JSON.parse(raw.toString()) as { type?: string; state?: string };
        } catch {
          return;
        }
        if (event.type === 'session.state_updated' && event.state === 'connected') {
          this.connected = true;
          this.finishReady(true);
        }
      });
      ws.on('close', () => {
        this.connected = false;
        this.finishReady(false);
      });
      ws.on('error', () => this.finishReady(false));
    });
  }

  speak(audio: string): void {
    this.send({ type: 'agent.speak', audio });
  }

  interrupt(): void {
    this.send({ type: 'agent.interrupt' });
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.finishReady(false);
    this.ws?.close();
    this.ws = null;
  }

  private finishReady(value: boolean): void {
    if (!this.readyResolve) return;
    const resolve = this.readyResolve;
    this.readyResolve = null;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    resolve(value);
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}
