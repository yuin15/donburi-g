interface Reaction {
  id: string;
  text: string;
  priority: number;
  expiresAt: number;
  current: () => boolean;
  final: boolean;
  essential: boolean;
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

  constructor(private readonly speak: (text: string) => void) {}

  offer(id: string, text: string, priority: number, current: () => boolean, final = false, essential = false, expiresInMs = final ? 3000 : 1800): void {
    if (this.closed || this.seen.has(id) || this.finalQueued) return;
    this.seen.add(id);
    if (final) {
      this.finalQueued = true;
      this.pending.clear();
      this.nextAt = 0;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.set(id, { id, text, priority, current, final, essential, expiresAt: Date.now() + expiresInMs });
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
      const candidates = [...this.pending.values()].filter(r => r.expiresAt > now && r.current());
      const ready = candidates.filter(r => r.final || ((r.essential || this.sent < 5) && now >= this.conversationUntil));
      this.pending.clear();
      // Ordinary commentary is discarded during a user turn. The one essential
      // state transition instead waits for the same conversation grace, so it
      // still cannot speak over the user and is not lost to the reaction cap.
      for (const reaction of candidates) {
        if (reaction.essential && !reaction.final && now < this.conversationUntil) this.pending.set(reaction.id, reaction);
      }
      const choice = ready.sort((a, b) => b.priority - a.priority)[0];
      if (!choice) {
        if (this.pending.size) {
          this.nextAt = Math.max(this.nextAt, this.conversationUntil);
          this.schedule();
        }
        return;
      }
      this.sent += 1;
      this.nextAt = now + 3000;
      this.speak(choice.text);
    }, Math.max(0, this.nextAt - Date.now()));
  }
}
