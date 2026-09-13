import type { IncomingMessage, ServerResponse } from 'node:http';

type Probe = () => Promise<unknown>;

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackHost(host: string): boolean {
  try {
    const name = new URL(`http://${host}`).hostname.toLowerCase();
    return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
  } catch {
    return false;
  }
}

/** Restrict paid local probes to a genuine same-origin browser request from this machine. */
export function isTrustedDevProbeRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(host) || fetchSite !== 'same-origin' || !origin) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function handleResponsesProbe(req: IncomingMessage, res: ServerResponse, probe: Probe): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!isTrustedDevProbeRequest(req)) return json(res, 403, { error: 'origin_not_allowed' });
  json(res, 200, await probe());
}
