interface Reaction {
  id: string;
  text: string;
  priority: number;
  expiresAt: number;
  current: () => boolean;
  final: boolean;
}

/** Pending speech only; provider playback/latency still needs real-media QA. */
export class ReactionQueue {
  private pending = new Map<string, Reaction>();
  private seen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt = 0;
  private sent = 0;
  private closed = false;
  private finalQueued = false;
  private conversationUntil = 0;

  constructor(private readonly speak: (text: string) => void, private readonly nextInitiatedAt: () => number = () => 0) {}

  offer(id: string, text: string, priority: number, current: () => boolean, final = false): void {
    if (this.closed || this.seen.has(id) || this.finalQueued) return;
    this.seen.add(id);
    if (final) {
      this.finalQueued = true;
      this.pending.clear();
      this.nextAt = 0;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.set(id, { id, text, priority, current, final, expiresAt: Date.now() + (final ? 3000 : 6000) });
    this.schedule();
  }

  conversationActivity(): void {
    if (this.closed) return;
    this.conversationUntil = Date.now() + 4000;
    this.pending.clear();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.seen.clear();
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      const allowedAt = this.nextInitiatedAt();
      if (now < allowedAt) {
        for (const [id, reaction] of this.pending) if (reaction.expiresAt <= now || !reaction.current()) this.pending.delete(id);
        this.schedule();
        return;
      }
      const ready = [...this.pending.values()].filter(r => r.expiresAt > now && r.current() && (r.final || (this.sent < 5 && now >= this.conversationUntil)));
      this.pending.clear();
      const choice = ready.sort((a, b) => b.priority - a.priority)[0];
      if (!choice) return;
      this.sent += 1;
      this.nextAt = now + 3000;
      this.speak(choice.text);
    }, Math.max(0, this.nextAt, this.nextInitiatedAt()) - Date.now());
  }
}
