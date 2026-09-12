import type { ClientMessage, ServerMessage } from '../../shared/protocol';

export interface LiveSession {
  connect(code: string): Promise<void>;
  disconnect(): Promise<void>;
  setMuted(muted: boolean): void;
  send(message: ClientMessage): void;
  sendSpin(): string | undefined;
}

export interface LiveSessionHandlers {
  message(message: ServerMessage): void;
  disconnect(): void;
}

export type LiveSessionFactory = (handlers: LiveSessionHandlers) => Promise<LiveSession>;

/** Keep browser media and EventTarget wiring outside the view model. */
export function createLiveSessionFactory(video: HTMLVideoElement): LiveSessionFactory {
  return async handlers => {
    const { LiveClient } = await import('./live');
    const client = new LiveClient(video);
    const onMessage = (event: Event) => handlers.message((event as CustomEvent<ServerMessage>).detail);
    const onDisconnect = () => handlers.disconnect();
    client.addEventListener('message', onMessage);
    client.addEventListener('disconnect', onDisconnect);

    // The owner establishes its generation before explicitly starting a connection.
    return {
      connect: code => client.connect(code),
      disconnect: () => {
        client.removeEventListener('message', onMessage);
        client.removeEventListener('disconnect', onDisconnect);
        return client.disconnect();
      },
      setMuted: muted => client.setMuted(muted),
      send: message => client.send(message),
      sendSpin: () => client.sendSpin(),
    };
  };
}
