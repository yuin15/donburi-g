function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const env = {
  openaiKey: process.env.OPENAI_API_KEY ?? '',
  liveAvatarKey: process.env.LIVEAVATAR_API_KEY ?? '',
  liveAvatarId: process.env.LIVEAVATAR_AVATAR_ID ?? '',
  liveAvatarApiUrl: process.env.LIVEAVATAR_API_URL ?? 'https://api.liveavatar.com',
  signingKey: process.env.SESSION_SIGNING_KEY ?? '',
  inviteCode: process.env.MVP_INVITE_CODE ?? '',
  liveEnabled: process.env.LIVE_MODE_ENABLED === 'true',
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  vercelUrl: process.env.VERCEL_URL ?? '',
  rivalModel: process.env.RIVAL_REASONING_MODEL ?? 'gpt-5.6-luna',
  gptLiveModel: process.env.GPT_LIVE_MODEL ?? 'gpt-live-1',
  gptLiveVoice: process.env.GPT_LIVE_VOICE ?? 'marin',
  maxDailySessions: intEnv('MAX_DAILY_SESSIONS', 10),
  maxConcurrentSessions: intEnv('MAX_CONCURRENT_SESSIONS', 1),
};

export function assertLiveConfiguration(voiceMode: 'audio' | 'avatar' = 'avatar'): void {
  if (!env.liveEnabled) throw new Error('live_mode_disabled');
  const missing: string[] = [];
  if (!env.openaiKey) missing.push('OPENAI_API_KEY');
  if (voiceMode === 'avatar' && !env.liveAvatarKey) missing.push('LIVEAVATAR_API_KEY');
  if (!env.signingKey) missing.push('SESSION_SIGNING_KEY');
  if (!env.inviteCode) missing.push('MVP_INVITE_CODE');
  if (missing.length) throw new Error(`missing_live_configuration:${missing.join(',')}`);
}
