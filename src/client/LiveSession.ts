import type { MicrophoneFeedback } from './MicrophoneInput';
import type { ClientMessage, ServerMessage, VoiceMode } from '../../shared/protocol';
import type { AiRuntimeEvent } from './AiStatus';

export interface LiveSession {
  connect(code: string, voiceMode?: VoiceMode): Promise<void>;
  disconnect(): Promise<void>;
  setMuted(muted: boolean): void;
  setMicMuted(muted: boolean): void;
  send(message: ClientMessage): void;
  sendSpin(): string | undefined;
}

export interface LiveSessionHandlers {
  message(message: ServerMessage): void;
  disconnect(): void;
  microphone(state: MicrophoneFeedback): void;
  aiStatus(event: AiRuntimeEvent): void;
}

export type LiveSessionFactory = (handlers: LiveSessionHandlers) => Promise<LiveSession>;

/** Keep browser media and EventTarget wiring outside the view model. */
export function createLiveSessionFactory(video: HTMLVideoElement): LiveSessionFactory {
  return async handlers => {
    const { LiveClient } = await import('./live');
    const client = new LiveClient(video);
    const onMessage = (event: Event) => handlers.message((event as CustomEvent<ServerMessage>).detail);
    const onDisconnect = () => handlers.disconnect();
    const onMicrophone = (event: Event) => handlers.microphone((event as CustomEvent<MicrophoneFeedback>).detail);
    const onAiStatus = (event: Event) => handlers.aiStatus((event as CustomEvent<AiRuntimeEvent>).detail);
    client.addEventListener('message', onMessage);
    client.addEventListener('disconnect', onDisconnect);
    client.addEventListener('microphone', onMicrophone);
    client.addEventListener('ai-status', onAiStatus);

    // The owner establishes its generation before explicitly starting a connection.
    return {
      connect: (code, voiceMode) => client.connect(code, voiceMode),
      disconnect: () => {
        client.removeEventListener('message', onMessage);
        client.removeEventListener('disconnect', onDisconnect);
        client.removeEventListener('microphone', onMicrophone);
        client.removeEventListener('ai-status', onAiStatus);
        return client.disconnect();
      },
      setMuted: muted => client.setMuted(muted),
      setMicMuted: muted => client.setMicMuted(muted),
      send: message => client.send(message),
      sendSpin: () => client.sendSpin(),
    };
  };
}
