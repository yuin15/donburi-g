export type AiProvider = 'gptLive' | 'liveAvatar' | 'liveKit';
export type AiConnectionState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';
export type AiRuntimeEvent = { provider: AiProvider; state: AiConnectionState };
