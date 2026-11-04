import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  executeRequest,
  isTextualContentType,
  RequestCancelledError,
  RequestTimeoutError,
} from '../../src/core/httpEngine';
import { clearTokenCache, fetchClientCredentialsToken } from '../../src/core/oauth2';
import type { ResolvedRequest } from '../../src/core/requestBuilder';

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

async function listen(handler: Handler): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let main: { server: Server; url: string };
let other: { server: Server; url: string };
let tokenCalls = 0;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'httpclient-engine-'));
  other = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers }));
  });
  main = await listen((req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    switch (url.pathname) {
      case '/echo':
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('set-cookie', ['a=1', 'b=2']);
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: body.toString('utf8') }));
        return;
      case '/redirect':
        res.statusCode = Number(url.searchParams.get('code') ?? 302);
        res.setHeader('location', url.searchParams.get('to') ?? '/echo');
        res.end();
        return;
      case '/loop':
        res.statusCode = 302;
        res.setHeader('location', '/loop');
        res.end();
        return;
      case '/slow':
        setTimeout(() => res.end('late'), 2000);
        return;
      case '/png':
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
        return;
      case '/big':
        res.setHeader('content-type', 'text/plain');
        res.end('x'.repeat(10_000));
        return;
      case '/token':
        tokenCalls++;
        res.setHeader('content-type', 'application/json');
        if (req.headers.authorization !== `Basic ${Buffer.from('id:secret').toString('base64')}` && !body.toString().includes('client_secret=secret')) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        res.end(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 3600 }));
        return;
      case '/token-bad':
        res.end(url.searchParams.get('body') ?? 'not json');
        return;
      default:
        res.statusCode = 404;
        res.end();
    }
  });
});

afterAll(async () => {
  await new Promise((r) => main.server.close(r));
  await new Promise((r) => other.server.close(r));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => clearTokenCache());

const get = (url: string, headers: [string, string][] = []): ResolvedRequest => ({ method: 'GET', url, headers, body: { kind: 'none' } });

describe('executeRequest', () => {
  it('sends method, headers and body and reports status, headers, timing and size', async () => {
    const res = await executeRequest({
      method: 'POST',
      url: `${main.url}/echo?x=1`,
      headers: [['Content-Type', 'application/json'], ['X-Test', 'yes']],
      body: { kind: 'text', text: '{"a":1}' },
    });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.bodyEncoding).toBe('utf8');
    const echo = JSON.parse(res.body);
    expect(echo).toMatchObject({ method: 'POST', url: '/echo?x=1', body: '{"a":1}' });
    expect(echo.headers['x-test']).toBe('yes');
    expect(res.headers.filter(([k]) => k === 'set-cookie')).toHaveLength(2);
    expect(res.sizeBytes).toBe(Buffer.byteLength(res.body));
    expect(res.timings.totalMs).toBeGreaterThanOrEqual(res.timings.ttfbMs);
  });

  it('follows redirects, switching POST to GET on 303 and keeping it on 307', async () => {
    const post = (code: number): ResolvedRequest => ({
      method: 'POST',
      url: `${main.url}/redirect?code=${code}`,
      headers: [['Content-Type', 'text/plain']],
      body: { kind: 'text', text: 'payload' },
    });
    const r303 = await executeRequest(post(303));
    expect(JSON.parse(r303.body)).toMatchObject({ method: 'GET', body: '' });
    expect(r303.redirects).toBe(1);
    expect(r303.url).toBe(`${main.url}/echo`);

    const r307 = await executeRequest(post(307));
    expect(JSON.parse(r307.body)).toMatchObject({ method: 'POST', body: 'payload' });
  });

  it('can disable redirects and caps redirect loops', async () => {
    const noFollow = await executeRequest(get(`${main.url}/redirect`), { followRedirects: false });
    expect(noFollow.status).toBe(302);
    const loop = await executeRequest(get(`${main.url}/loop`), { maxRedirects: 3 });
    expect(loop.status).toBe(302);
    expect(loop.redirects).toBe(3);
  });

  it('drops Authorization and Cookie headers on cross-origin redirects', async () => {
    const to = encodeURIComponent(`${other.url}/anything`);
    const res = await executeRequest(get(`${main.url}/redirect?to=${to}`, [['Authorization', 'Bearer secret'], ['Cookie', 'sid=1'], ['X-Keep', '1']]));
    const { headers } = JSON.parse(res.body);
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-keep']).toBe('1');
  });

  it('returns binary bodies as base64 and truncates oversized responses', async () => {
    const png = await executeRequest(get(`${main.url}/png`));
    expect(png.bodyEncoding).toBe('base64');
    expect(Buffer.from(png.body, 'base64')[1]).toBe(0x50);

    const big = await executeRequest(get(`${main.url}/big`), { maxResponseBytes: 100 });
    expect(big.truncated).toBe(true);
    expect(big.body).toHaveLength(100);
    expect(big.sizeBytes).toBe(100);
  });

  it('times out and supports cancellation', async () => {
    await expect(executeRequest(get(`${main.url}/slow`), { timeoutMs: 100 })).rejects.toBeInstanceOf(RequestTimeoutError);
    const ac = new AbortController();
    const pending = executeRequest(get(`${main.url}/slow`), { timeoutMs: 0 }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it('uploads multipart files and binary bodies relative to baseDir', async () => {
    await writeFile(join(dir, 'hello.txt'), 'hello file');
    const multipart = await executeRequest(
      { method: 'POST', url: `${main.url}/echo`, headers: [], body: { kind: 'multipart', fields: [{ name: 'doc', value: 'hello.txt', isFile: true }, { name: 'note', value: 'hi', isFile: false }] } },
      { baseDir: dir },
    );
    const echo = JSON.parse(multipart.body);
    expect(echo.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(echo.body).toContain('filename="hello.txt"');
    expect(echo.body).toContain('hello file');
    expect(echo.body).toContain('name="note"');

    const binary = await executeRequest({ method: 'PUT', url: `${main.url}/echo`, headers: [], body: { kind: 'file', path: join(dir, 'hello.txt') } });
    expect(JSON.parse(binary.body).body).toBe('hello file');
  });

  it('sends each file part with a content type from its extension and keeps repeated names', async () => {
    await writeFile(join(dir, 'pic.png'), 'png-bytes');
    await writeFile(join(dir, 'other.png'), 'png-2');
    await writeFile(join(dir, 'blob.weird'), 'raw');
    const res = await executeRequest(
      {
        method: 'POST',
        url: `${main.url}/echo`,
        headers: [],
        body: {
          kind: 'multipart',
          fields: [
            { name: 'files[]', value: 'pic.png', isFile: true },
            { name: 'files[]', value: 'other.png', isFile: true },
            { name: 'raw', value: 'blob.weird', isFile: true },
            { name: 'tags', value: 'a', isFile: false },
            { name: 'tags', value: 'b', isFile: false },
          ],
        },
      },
      { baseDir: dir },
    );
    const body: string = JSON.parse(res.body).body;
    const parts = body.split(/--[^\r\n]+\r\n/).filter((p) => p.includes('Content-Disposition'));
    expect(parts).toHaveLength(5);
    expect(parts[0]).toMatch(/name="files\[\]"; filename="pic.png"\r\nContent-Type: image\/png/);
    expect(parts[1]).toMatch(/name="files\[\]"; filename="other.png"\r\nContent-Type: image\/png/);
    expect(parts[2]).toMatch(/filename="blob.weird"\r\nContent-Type: application\/octet-stream/);
    expect(parts.filter((p) => p.includes('name="tags"'))).toHaveLength(2);
  });

  it('propagates connection errors', async () => {
    await expect(executeRequest(get('http://127.0.0.1:1/'), { timeoutMs: 2000 })).rejects.toThrow();
  });

  it('fetches and caches OAuth2 client-credentials tokens and sends them as Bearer', async () => {
    const oauth2 = { type: 'oauth2' as const, grant: 'client_credentials' as const, tokenUrl: `${main.url}/token`, clientId: 'id', clientSecret: 'secret', scope: 'read' };
    const first = await executeRequest({ ...get(`${main.url}/echo`, [['Authorization', 'stale']]), oauth2 });
    expect(JSON.parse(first.body).headers.authorization).toBe('Bearer tok-1');
    const second = await executeRequest({ ...get(`${main.url}/echo`), oauth2 });
    expect(JSON.parse(second.body).headers.authorization).toBe('Bearer tok-1');
    const viaBody = await executeRequest({ ...get(`${main.url}/echo`), oauth2: { ...oauth2, clientAuthentication: 'body' } });
    expect(JSON.parse(viaBody.body).headers.authorization).toBe('Bearer tok-2');
  });
});

describe('fetchClientCredentialsToken errors', () => {
  const cfg = (tokenUrl: string, clientSecret = 'secret') => ({
    type: 'oauth2' as const,
    grant: 'client_credentials' as const,
    tokenUrl,
    clientId: 'id',
    clientSecret,
  });

  it('rejects failed, non-JSON and token-less responses', async () => {
    await expect(fetchClientCredentialsToken(cfg(`${main.url}/token`, 'wrong'))).rejects.toThrow(/HTTP 401/);
    await expect(fetchClientCredentialsToken(cfg(`${main.url}/token-bad`))).rejects.toThrow(/not valid JSON/);
    await expect(fetchClientCredentialsToken(cfg(`${main.url}/token-bad?body=%7B%7D`))).rejects.toThrow(/no access_token/);
  });

  it('refreshes expired tokens', async () => {
    let now = 0;
    const clock = () => now;
    const a = await fetchClientCredentialsToken(cfg(`${main.url}/token`), undefined, undefined, clock);
    now = 3600_000;
    const b = await fetchClientCredentialsToken(cfg(`${main.url}/token`), undefined, undefined, clock);
    expect(a).not.toBe(b);
  });
});

describe('isTextualContentType', () => {
  it('classifies common types', () => {
    for (const t of ['text/html', 'application/json', 'application/problem+json', 'application/vnd.api+json', 'application/xml', 'application/javascript']) {
      expect(isTextualContentType(t)).toBe(true);
    }
    for (const t of ['image/png', 'application/octet-stream', 'application/pdf']) expect(isTextualContentType(t)).toBe(false);
  });
});
