import { describe, expect, it } from 'vitest';
import { buildRequest, toCurl } from '../../src/core/requestBuilder';
import { VariableResolver } from '../../src/core/variables';
import { newRequest, type RequestItem } from '../../src/shared/model';

const resolver = () =>
  new VariableResolver({
    collection: [
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true },
      { key: 'token', value: 's3cr3t', enabled: true },
    ],
  });

function req(patch: Partial<RequestItem>): RequestItem {
  return { ...newRequest('r'), url: '{{baseUrl}}/items', ...patch };
}

describe('buildRequest', () => {
  it('resolves URL, query params and headers, skipping disabled/empty rows', () => {
    const out = buildRequest(
      req({
        params: [
          { key: 'q', value: '{{token}}', enabled: true },
          { key: 'off', value: 'x', enabled: false },
          { key: '', value: 'empty', enabled: true },
        ],
        headers: [{ key: 'X-Trace', value: 'abc', enabled: true }],
      }),
      { type: 'none' },
      resolver(),
    );
    expect(out.url).toBe('https://api.example.com/items?q=s3cr3t');
    expect(out.headers).toEqual([['X-Trace', 'abc']]);
    expect(out.body).toEqual({ kind: 'none' });
  });

  it('defaults the scheme to http and rejects bad URLs', () => {
    expect(buildRequest(req({ url: 'localhost:3000/x' }), { type: 'none' }, resolver()).url).toBe('http://localhost:3000/x');
    expect(() => buildRequest(req({ url: '' }), { type: 'none' }, resolver())).toThrow(/empty/);
    expect(() => buildRequest(req({ url: 'http://' }), { type: 'none' }, resolver())).toThrow(/Invalid URL/);
    expect(() => buildRequest(req({ url: 'ftp://x/y' }), { type: 'none' }, resolver())).toThrow(/Unsupported protocol/);
  });

  it('applies basic, bearer and api key auth', () => {
    const basic = buildRequest(req({}), { type: 'basic', username: 'u', password: '{{token}}' }, resolver());
    expect(basic.headers).toContainEqual(['Authorization', `Basic ${Buffer.from('u:s3cr3t').toString('base64')}`]);

    const bearer = buildRequest(req({}), { type: 'bearer', token: '{{token}}' }, resolver());
    expect(bearer.headers).toContainEqual(['Authorization', 'Bearer s3cr3t']);

    const header = buildRequest(req({}), { type: 'apikey', key: 'X-Key', value: '{{token}}', in: 'header' }, resolver());
    expect(header.headers).toContainEqual(['X-Key', 's3cr3t']);

    const query = buildRequest(req({}), { type: 'apikey', key: 'key', value: 'v', in: 'query' }, resolver());
    expect(query.url).toBe('https://api.example.com/items?key=v');
  });

  it('does not override an explicit Authorization header', () => {
    const out = buildRequest(
      req({ headers: [{ key: 'authorization', value: 'Custom x', enabled: true }] }),
      { type: 'bearer', token: 't' },
      resolver(),
    );
    expect(out.headers).toEqual([['authorization', 'Custom x']]);
  });

  it('passes oauth2 config through resolved', () => {
    const out = buildRequest(
      req({}),
      { type: 'oauth2', grant: 'client_credentials', tokenUrl: '{{baseUrl}}/token', clientId: 'id', clientSecret: '{{token}}', scope: 'a b' },
      resolver(),
    );
    expect(out.oauth2).toMatchObject({ tokenUrl: 'https://api.example.com/token', clientSecret: 's3cr3t', scope: 'a b' });
  });

  it('builds bodies and default content types', () => {
    const json = buildRequest(req({ method: 'POST', body: { type: 'json', raw: '{"t":"{{token}}"}' } }), { type: 'none' }, resolver());
    expect(json.body).toEqual({ kind: 'text', text: '{"t":"s3cr3t"}' });
    expect(json.headers).toContainEqual(['Content-Type', 'application/json']);

    const form = buildRequest(
      req({ body: { type: 'form', form: [{ key: 'a', value: '1 2', enabled: true }, { key: 'b', value: 'x', enabled: false }] } }),
      { type: 'none' },
      resolver(),
    );
    expect(form.body).toEqual({ kind: 'text', text: 'a=1+2' });
    expect(form.headers).toContainEqual(['Content-Type', 'application/x-www-form-urlencoded']);

    const custom = buildRequest(
      req({ headers: [{ key: 'Content-Type', value: 'application/vnd.api+json', enabled: true }], body: { type: 'json', raw: '{}' } }),
      { type: 'none' },
      resolver(),
    );
    expect(custom.headers.filter(([k]) => k.toLowerCase() === 'content-type')).toHaveLength(1);

    const multipart = buildRequest(
      req({ body: { type: 'multipart', multipart: [{ key: 'f', value: 'a.txt', enabled: true, kind: 'file' }, { key: 't', value: 'v', enabled: true, kind: 'text' }] } }),
      { type: 'none' },
      resolver(),
    );
    expect(multipart.body).toEqual({ kind: 'multipart', fields: [{ name: 'f', value: 'a.txt', isFile: true }, { name: 't', value: 'v', isFile: false }] });
    expect(multipart.headers).toEqual([]);

    expect(buildRequest(req({ body: { type: 'binary', file: 'x.bin' } }), { type: 'none' }, resolver()).body).toEqual({ kind: 'file', path: 'x.bin' });
    expect(buildRequest(req({ body: { type: 'binary' } }), { type: 'none' }, resolver()).body).toEqual({ kind: 'none' });
    expect(buildRequest(req({ body: { type: 'xml', raw: '<a/>' } }), { type: 'none' }, resolver()).headers).toContainEqual(['Content-Type', 'application/xml']);
  });

  it('renders curl with shell-safe quoting', () => {
    const r = buildRequest(req({ method: 'POST', body: { type: 'text', raw: "it's" } }), { type: 'none' }, resolver());
    expect(toCurl(r)).toBe(`curl -X POST 'https://api.example.com/items' -H 'Content-Type: text/plain' --data-raw 'it'\\''s'`);
    expect(toCurl({ method: 'PUT', url: 'http://x', headers: [], body: { kind: 'file', path: 'a.bin' } })).toContain("--data-binary '@a.bin'");
    expect(toCurl({ method: 'POST', url: 'http://x', headers: [], body: { kind: 'multipart', fields: [{ name: 'f', value: 'a', isFile: true }] } })).toContain("-F 'f=@a'");
  });
});
