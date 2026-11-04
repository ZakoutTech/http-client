import { request, type Dispatcher } from 'undici';
import type { ResolvedOAuth2 } from './requestBuilder';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const EXPIRY_SKEW_MS = 30_000;

// In-memory only; includes the secret so a changed secret never reuses a stale token.
const cacheKey = (cfg: ResolvedOAuth2) =>
  JSON.stringify([cfg.tokenUrl, cfg.clientId, cfg.clientSecret, cfg.scope ?? '', cfg.clientAuthentication ?? 'header']);

export function clearTokenCache(): void {
  cache.clear();
}

/** OAuth2 client-credentials grant (RFC 6749 §4.4) with an in-memory token cache. */
export async function fetchClientCredentialsToken(
  cfg: ResolvedOAuth2,
  dispatcher?: Dispatcher,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<string> {
  const key = cacheKey(cfg);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) return cached.token;

  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (cfg.scope) form.set('scope', cfg.scope);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (cfg.clientAuthentication === 'body') {
    form.set('client_id', cfg.clientId);
    form.set('client_secret', cfg.clientSecret);
  } else {
    const enc = (s: string) => encodeURIComponent(s);
    headers.authorization = `Basic ${Buffer.from(`${enc(cfg.clientId)}:${enc(cfg.clientSecret)}`).toString('base64')}`;
  }

  const res = await request(cfg.tokenUrl, { method: 'POST', headers, body: form.toString(), dispatcher, signal });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`OAuth2 token request failed with HTTP ${res.statusCode}`);
  }
  let json: { access_token?: unknown; expires_in?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('OAuth2 token response is not valid JSON');
  }
  if (typeof json.access_token !== 'string' || !json.access_token) {
    throw new Error('OAuth2 token response has no access_token');
  }
  const ttlMs = typeof json.expires_in === 'number' ? json.expires_in * 1000 : 3600_000;
  cache.set(key, { token: json.access_token, expiresAt: now() + Math.max(0, ttlMs - EXPIRY_SKEW_MS) });
  return json.access_token;
}
