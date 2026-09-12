import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedOrigin, issueTicket } from '../server/auth.js';
import { assertLiveConfiguration } from '../server/env.js';

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, req.headers.host)) {
    json(res, 403, { error: 'origin_not_allowed' });
    return;
  }
  const codeHeader = req.headers['x-invite-code'];
  const code = Array.isArray(codeHeader) ? codeHeader[0] : codeHeader;
  if (!code || code.length > 200) {
    json(res, 401, { error: 'invalid_access' });
    return;
  }
  try {
    assertLiveConfiguration();
    const ticket = issueTicket(code, origin ?? '');
    json(res, 200, { ticket, expiresIn: 60 });
  } catch {
    json(res, 401, { error: 'invalid_access' });
  }
}
