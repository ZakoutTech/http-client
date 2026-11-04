import type { Auth, HttpMethod, KeyValue, RequestItem } from '../shared/model';
import type { VariableResolver } from './variables';

export type ResolvedBody =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'multipart'; fields: { name: string; value: string; isFile: boolean }[] }
  | { kind: 'file'; path: string };

export type ResolvedOAuth2 = Extract<Auth, { type: 'oauth2' }>;

export interface ResolvedRequest {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  body: ResolvedBody;
  /** Set when a token must be fetched and added as a Bearer header before sending. */
  oauth2?: ResolvedOAuth2;
}

const DEFAULT_CONTENT_TYPE: Partial<Record<RequestItem['body']['type'], string>> = {
  json: 'application/json',
  xml: 'application/xml',
  text: 'text/plain',
  form: 'application/x-www-form-urlencoded',
  binary: 'application/octet-stream',
};

const enabled = (list: KeyValue[] | undefined): KeyValue[] => (list ?? []).filter((kv) => kv.enabled && kv.key.trim());

function hasHeader(headers: [string, string][], name: string): boolean {
  const lower = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === lower);
}

export function buildRequest(item: RequestItem, auth: Auth, resolver: VariableResolver): ResolvedRequest {
  const r = (s: string) => resolver.resolve(s ?? '');

  let rawUrl = r(item.url).trim();
  if (!rawUrl) throw new Error('URL is empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) rawUrl = `http://${rawUrl}`;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  for (const p of enabled(item.params)) url.searchParams.append(r(p.key), r(p.value));

  const headers: [string, string][] = enabled(item.headers).map((h) => [r(h.key).trim(), r(h.value)]);

  let oauth2: ResolvedOAuth2 | undefined;
  if (!hasHeader(headers, 'authorization') || auth.type === 'apikey') {
    switch (auth.type) {
      case 'basic': {
        const creds = Buffer.from(`${r(auth.username)}:${r(auth.password)}`, 'utf8').toString('base64');
        headers.push(['Authorization', `Basic ${creds}`]);
        break;
      }
      case 'bearer':
        headers.push(['Authorization', `Bearer ${r(auth.token)}`]);
        break;
      case 'apikey':
        if (auth.in === 'query') url.searchParams.append(r(auth.key), r(auth.value));
        else if (!hasHeader(headers, r(auth.key))) headers.push([r(auth.key), r(auth.value)]);
        break;
      case 'oauth2':
        oauth2 = {
          ...auth,
          tokenUrl: r(auth.tokenUrl),
          clientId: r(auth.clientId),
          clientSecret: r(auth.clientSecret),
          scope: auth.scope ? r(auth.scope) : undefined,
        };
        break;
      default:
        break;
    }
  }

  const body = buildBody(item, r);
  const defaultType = DEFAULT_CONTENT_TYPE[item.body.type];
  if (defaultType && body.kind !== 'none' && !hasHeader(headers, 'content-type')) {
    headers.push(['Content-Type', defaultType]);
  }

  return { method: item.method, url: url.toString(), headers, body, oauth2 };
}

function buildBody(item: RequestItem, r: (s: string) => string): ResolvedBody {
  const b = item.body;
  switch (b.type) {
    case 'json':
    case 'text':
    case 'xml':
      return { kind: 'text', text: r(b.raw ?? '') };
    case 'form': {
      const params = new URLSearchParams();
      for (const kv of enabled(b.form)) params.append(r(kv.key), r(kv.value));
      return { kind: 'text', text: params.toString() };
    }
    case 'multipart':
      return {
        kind: 'multipart',
        fields: enabled(b.multipart).map((f) => ({
          name: r(f.key),
          value: r(f.value),
          isFile: (f as { kind?: string }).kind === 'file',
        })),
      };
    case 'binary':
      return b.file ? { kind: 'file', path: r(b.file) } : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

/** Renders a resolved request as a curl command (for "Copy as cURL"). */
export function toCurl(req: ResolvedRequest): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = ['curl', '-X', req.method, q(req.url)];
  for (const [k, v] of req.headers) parts.push('-H', q(`${k}: ${v}`));
  if (req.body.kind === 'text') parts.push('--data-raw', q(req.body.text));
  if (req.body.kind === 'file') parts.push('--data-binary', q(`@${req.body.path}`));
  if (req.body.kind === 'multipart') {
    for (const f of req.body.fields) parts.push('-F', q(`${f.name}=${f.isFile ? '@' : ''}${f.value}`));
  }
  return parts.join(' ');
}
