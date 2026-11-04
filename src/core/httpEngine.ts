import { readFile } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import { basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { Agent, FormData, ProxyAgent, request, type Dispatcher } from 'undici';
import type { ResponseData } from '../shared/model';
import { fetchClientCredentialsToken } from './oauth2';
import type { ResolvedRequest } from './requestBuilder';

export interface EngineOptions {
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  strictSSL: boolean;
  proxy?: string;
  maxResponseBytes: number;
  /** Base directory for relative file paths (multipart files, binary body). */
  baseDir?: string;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  strictSSL: true,
  maxResponseBytes: 50 * 1024 * 1024,
};

export class RequestTimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${ms} ms`);
    this.name = 'RequestTimeoutError';
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'RequestCancelledError';
  }
}

const TEXTUAL = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|yaml|x-yaml|graphql|csv|html|xhtml\+xml|problem\+json|ld\+json))/i;

export function isTextualContentType(contentType: string): boolean {
  return TEXTUAL.test(contentType.trim());
}

export function createDispatcher(opts: EngineOptions): Dispatcher {
  const tls = { rejectUnauthorized: opts.strictSSL };
  return opts.proxy
    ? new ProxyAgent({ uri: opts.proxy, requestTls: tls, proxyTls: tls })
    : new Agent({ connect: tls });
}

async function readLocalFile(path: string, baseDir?: string): Promise<Buffer> {
  const full = isAbsolute(path) || !baseDir ? path : resolvePath(baseDir, path);
  return readFile(full);
}

async function buildBody(req: ResolvedRequest, baseDir?: string): Promise<string | Buffer | FormData | undefined> {
  switch (req.body.kind) {
    case 'text':
      return req.body.text;
    case 'file':
      return readLocalFile(req.body.path, baseDir);
    case 'multipart': {
      const form = new FormData();
      for (const f of req.body.fields) {
        if (f.isFile) {
          const data = await readLocalFile(f.value, baseDir);
          form.append(f.name, new Blob([new Uint8Array(data)]), basename(f.value));
        } else {
          form.append(f.name, f.value);
        }
      }
      return form;
    }
    default:
      return undefined;
  }
}

function headerPairs(headers: Record<string, string | string[] | undefined>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) out.push([k, item]);
  }
  return out;
}

function headerValue(pairs: [string, string][], name: string): string {
  const lower = name.toLowerCase();
  return pairs.find(([k]) => k.toLowerCase() === lower)?.[1] ?? '';
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Executes a resolved request. Handles OAuth2 token acquisition, redirects (manually, so the
 * Authorization header is dropped on cross-origin hops), timeouts, cancellation and size limits.
 */
export async function executeRequest(
  req: ResolvedRequest,
  options: Partial<EngineOptions> = {},
  signal?: AbortSignal,
): Promise<ResponseData> {
  const opts: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  const dispatcher = createDispatcher(opts);
  const timeoutSignal = opts.timeoutMs > 0 ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  const signals = [signal, timeoutSignal].filter((s): s is AbortSignal => !!s);
  const combined = signals.length ? AbortSignal.any(signals) : undefined;

  const start = performance.now();
  try {
    let headers = [...req.headers];
    if (req.oauth2) {
      const token = await fetchClientCredentialsToken(req.oauth2, dispatcher, combined);
      headers = headers.filter(([k]) => k.toLowerCase() !== 'authorization');
      headers.push(['Authorization', `Bearer ${token}`]);
    }

    let method: string = req.method;
    let url = req.url;
    let body = await buildBody(req, opts.baseDir);
    let redirects = 0;

    for (;;) {
      const res = await request(url, {
        method: method as Dispatcher.HttpMethod,
        headers: headers.flatMap(([k, v]) => [k, v]),
        body,
        dispatcher,
        signal: combined,
      });
      const ttfbMs = performance.now() - start;
      const resHeaders = headerPairs(res.headers);
      const location = headerValue(resHeaders, 'location');

      if (opts.followRedirects && REDIRECT_STATUSES.has(res.statusCode) && location && redirects < opts.maxRedirects) {
        await res.body.dump();
        const next = new URL(location, url);
        if (next.origin !== new URL(url).origin) {
          headers = headers.filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase()));
        }
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          headers = headers.filter(([k]) => !['content-type', 'content-length'].includes(k.toLowerCase()));
        }
        url = next.toString();
        redirects++;
        continue;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of res.body) {
        const buf = chunk as Buffer;
        if (size + buf.length > opts.maxResponseBytes) {
          chunks.push(buf.subarray(0, opts.maxResponseBytes - size));
          size = opts.maxResponseBytes;
          truncated = true;
          break;
        }
        chunks.push(buf);
        size += buf.length;
      }
      const data = Buffer.concat(chunks);
      const contentType = headerValue(resHeaders, 'content-type');
      const textual = isTextualContentType(contentType) || (!contentType && !data.includes(0));

      return {
        status: res.statusCode,
        statusText: STATUS_CODES[res.statusCode] ?? '',
        headers: resHeaders,
        body: textual ? data.toString('utf8') : data.toString('base64'),
        bodyEncoding: textual ? 'utf8' : 'base64',
        contentType,
        sizeBytes: size,
        truncated,
        timings: { ttfbMs: Math.round(ttfbMs), totalMs: Math.round(performance.now() - start) },
        url,
        redirects,
      };
    }
  } catch (err) {
    if (timeoutSignal?.aborted && !signal?.aborted) throw new RequestTimeoutError(opts.timeoutMs);
    if (signal?.aborted) throw new RequestCancelledError();
    throw err;
  } finally {
    void dispatcher.close().catch(() => undefined);
  }
}
