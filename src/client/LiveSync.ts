import type { ServerEnvelope, ServerMessage } from '../../shared/protocol';

/** Per-connection sequence, independent from the domain's event sequence. */
export class LiveSync {
  sessionId: string | null = null;
  private sequence = 0;
  private recovering = false;

  accept(wire: ServerEnvelope): { message: ServerMessage | null; requestSnapshot: boolean } {
    if (!this.sessionId) {
      if (wire.type !== 'hello' || wire.streamSeq !== 1) throw new Error('missing_hello');
      this.sessionId = wire.sessionId;
    }
    if (wire.sessionId !== this.sessionId) throw new Error('wrong_match');
    if (wire.streamSeq <= this.sequence) return { message: null, requestSnapshot: false };
    const gap = wire.streamSeq !== this.sequence + 1;
    this.sequence = wire.streamSeq;
    const requestSnapshot = gap && !this.recovering && wire.type !== 'snapshot';
    this.recovering ||= gap;
    if (wire.type === 'snapshot') this.recovering = false;
    const critical = wire.type === 'error' || (wire.type === 'voice_status' && (wire.status === 'error' || wire.status === 'closed'));
    if (this.recovering && !critical) return { message: null, requestSnapshot };
    const payload: Partial<ServerEnvelope> = { ...wire };
    delete payload.streamSeq;
    delete payload.serverTime;
    // hello's session id is part of its payload as well as the envelope.
    if (wire.type !== 'hello') delete payload.sessionId;
    return { message: payload as ServerMessage, requestSnapshot };
  }
}
