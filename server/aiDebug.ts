import { env } from './env.js';

export type AiDebugConnection = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

export interface AiDebugStatus {
  readonly configured: {
    readonly gptLive: boolean;
    readonly responses: boolean;
    readonly liveAvatar: boolean;
    readonly liveKit: boolean;
  };
}

type DebugEnvironment = Pick<typeof env, 'liveEnabled' | 'openaiKey' | 'liveAvatarKey' | 'signingKey' | 'inviteCode'>;

/** Deliberately exposes capability booleans only: never provider values or partial secret names. */
export function getAiDebugStatus(source: DebugEnvironment = env): AiDebugStatus {
  const liveBase = source.liveEnabled && !!source.openaiKey && !!source.signingKey && !!source.inviteCode;
  const avatar = liveBase && !!source.liveAvatarKey;
  return {
    configured: {
      gptLive: liveBase,
      responses: !!source.openaiKey,
      liveAvatar: avatar,
      // LiveKit credentials are minted by LiveAvatar, so this means the video path can request them.
      liveKit: avatar,
    },
  };
}

export async function probeResponses(source: Pick<typeof env, 'openaiKey' | 'rivalModel'> = env): Promise<{ state: 'connected' | 'failed' | 'not_configured' }> {
  if (!source.openaiKey) return { state: 'not_configured' };
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${source.openaiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(4_000),
      body: JSON.stringify({
        model: source.rivalModel,
        input: 'ping',
        store: false,
        max_output_tokens: 16,
        reasoning: { effort: 'none' },
      }),
    });
    return { state: response.ok ? 'connected' : 'failed' };
  } catch {
    return { state: 'failed' };
  }
}
