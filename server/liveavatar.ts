import { env } from './env.js';

export interface StartedAvatarSession {
  sessionId: string;
  livekitUrl: string;
  livekitToken: string;
  mediaWsUrl: string;
}

async function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${env.liveAvatarApiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`liveavatar_http_${response.status}`);
  const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
  return parsed.data ?? {};
}

let fallbackAvatarId = '';

async function resolveAvatarId(): Promise<string> {
  if (env.liveAvatarId) return env.liveAvatarId;
  if (fallbackAvatarId) return fallbackAvatarId;
  const response = await fetch(`${env.liveAvatarApiUrl}/v1/avatars/public?page_size=20`, {
    headers: { 'X-API-KEY': env.liveAvatarKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`liveavatar_avatar_list_${response.status}`);
  const payload = (await response.json()) as {
    data?: { results?: Array<{ id?: string; status?: string; type?: string }> };
  };
  const avatars = payload.data?.results ?? [];
  const pick = avatars.find((item) => item.status === 'ACTIVE' && item.type === 'VIDEO') ?? avatars.find((item) => item.status === 'ACTIVE');
  if (!pick?.id) throw new Error('liveavatar_no_avatar');
  fallbackAvatarId = pick.id;
  return pick.id;
}

export async function startAvatarSession(): Promise<StartedAvatarSession> {
  const token = await post(
    '/v1/sessions/token',
    { mode: 'LITE', avatar_id: await resolveAvatarId() },
    { 'X-API-KEY': env.liveAvatarKey },
  );
  const sessionId = String(token.session_id ?? '');
  const sessionToken = String(token.session_token ?? '');
  if (!sessionId || !sessionToken) throw new Error('liveavatar_token_invalid');

  try {
    const started = await post('/v1/sessions/start', {}, { Authorization: `Bearer ${sessionToken}` });
    const livekitUrl = String(started.livekit_url ?? '');
    const livekitToken = String(started.livekit_client_token ?? '');
    const mediaWsUrl = String(started.ws_url ?? '');
    if (!livekitUrl || !livekitToken || !mediaWsUrl) throw new Error('liveavatar_start_invalid');
    return { sessionId, livekitUrl, livekitToken, mediaWsUrl };
  } catch (error) {
    // The provider may have started billing even when its response failed.
    await stopAvatarSession(sessionId).catch(() => undefined);
    throw error;
  }
}

export async function stopAvatarSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await post('/v1/sessions/stop', { session_id: sessionId }, { 'X-API-KEY': env.liveAvatarKey });
}
