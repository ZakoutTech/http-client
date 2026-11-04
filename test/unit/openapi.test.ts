import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exampleToString, generateExample } from '../../src/core/openapi/example';
import { convertSpec, importOpenApi, parseSpecText } from '../../src/core/openapi/importer';
import type { Collection, CollectionItem, FolderItem, RequestItem } from '../../src/shared/model';

const fixtures = join(__dirname, '..', 'fixtures');

async function load(name: string): Promise<Collection> {
  const location = join(fixtures, name);
  return importOpenApi({ text: await readFile(location, 'utf8'), location, isUrl: false });
}

function requests(items: CollectionItem[]): RequestItem[] {
  return items.flatMap((i) => (i.type === 'request' ? [i] : requests(i.items)));
}

const byName = (c: Collection, name: string) => requests(c.items).find((r) => r.name === name) as RequestItem;
const varOf = (c: Collection, key: string) => c.variables.find((v) => v.key === key)?.value;

describe('OpenAPI import — Swagger 2.0 Petstore', () => {
  it('maps tags to folders and operations to requests', async () => {
    const c = await load('petstore-2.0.json');
    expect(c.name).toBe('Swagger Petstore');
    expect(c.items.map((i) => i.name)).toEqual(['pet', 'store', 'user']);
    expect((c.items[0] as FolderItem).items).toHaveLength(7);
    expect(requests(c.items)).toHaveLength(9);
    expect(varOf(c, 'baseUrl')).toBe('https://petstore.swagger.io/v2');
  });

  it('builds URLs with path variables, query params and headers', async () => {
    const c = await load('petstore-2.0.json');
    const get = byName(c, 'getPetById');
    expect(get.url).toBe('{{baseUrl}}/pet/{{petId}}');
    expect(varOf(c, 'petId')).toBe('0');
    expect(get.auth).toEqual({ type: 'apikey', key: 'api_key', value: '{{apiKey}}', in: 'header' });

    const login = byName(c, 'Logs user into the system');
    expect(login.params.map((p) => [p.key, p.enabled])).toEqual([
      ['username', true],
      ['password', true],
    ]);
    expect(byName(c, 'Deletes a pet').headers).toEqual([{ key: 'api_key', value: 'string', enabled: false, description: undefined }]);
    expect(byName(c, 'Finds Pets by status').params[0].value).toBe('["available"]');
  });

  it('generates JSON, XML, form and multipart bodies (incl. circular schemas)', async () => {
    const c = await load('petstore-2.0.json');
    const add = byName(c, 'Add a new pet');
    expect(add.body.type).toBe('json');
    const pet = JSON.parse(add.body.raw as string);
    expect(pet.name).toBe('doggie');
    expect(pet.status).toBe('available');
    expect(pet.category).toHaveProperty('name');

    const update = byName(c, 'Update an existing pet');
    expect(update.body.type).toBe('json'); // JSON preferred over XML when both are offered

    const form = byName(c, 'Updates a pet with form data');
    expect(form.body).toEqual({
      type: 'form',
      form: [
        { key: 'name', value: 'string', enabled: true },
        { key: 'status', value: 'available', enabled: true },
      ],
    });

    const upload = byName(c, 'uploads an image');
    expect(upload.body.type).toBe('multipart');
    expect(upload.body.multipart?.find((f) => f.key === 'file')).toMatchObject({ kind: 'file', value: '' });
  });
});

describe('OpenAPI import — 3.1 Petstore (YAML)', () => {
  it('maps folders, root requests and server variables', async () => {
    const c = await load('petstore-3.1.yaml');
    expect(c.items.map((i) => i.name)).toEqual(['pets', 'reports', 'Health check']);
    expect(requests(c.items)).toHaveLength(6);
    expect(varOf(c, 'baseUrl')).toBe('https://petstore.example.com/api/v3');
    expect(varOf(c, 'petId')).toBe('42');
  });

  it('maps security: collection bearer, public override, oauth2 client credentials', async () => {
    const c = await load('petstore-3.1.yaml');
    expect(c.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(byName(c, 'Get pet').auth).toEqual({ type: 'inherit' });
    expect(byName(c, 'Delete pet (public)').auth).toEqual({ type: 'none' });
    expect(byName(c, 'Machine report').auth).toMatchObject({
      type: 'oauth2',
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: '{{clientId}}',
      scope: 'pets.read',
    });
  });

  it('skips readOnly properties in request bodies and handles circular oneOf', async () => {
    const c = await load('petstore-3.1.yaml');
    const body = JSON.parse(byName(c, 'Create pet').body.raw as string);
    expect(body).not.toHaveProperty('id');
    expect(body.name).toBe('doggie');
    expect(body.tags).toEqual(['string']);
    expect(byName(c, 'List pets').params[0]).toMatchObject({ key: 'limit', value: '20', enabled: false });
  });
});

describe('importer edge cases', () => {
  it('rejects non-OpenAPI and unsupported documents', () => {
    expect(() => parseSpecText('{"hello":1}')).toThrow(/Not an OpenAPI/);
    expect(() => parseSpecText('swagger: "1.2"')).toThrow(/Unsupported Swagger/);
    expect(() => parseSpecText('openapi: 4.0.0')).toThrow(/Unsupported OpenAPI/);
    expect(() => parseSpecText('{ broken')).toThrow(/Could not parse/);
    expect(() => parseSpecText('42')).toThrow(/not an object/);
  });

  it('resolves relative servers against the spec URL and picks content types', () => {
    const c = convertSpec(
      {
        openapi: '3.0.3',
        info: { title: '' },
        servers: [{ url: '/api/' }],
        components: {
          securitySchemes: {
            basic: { type: 'http', scheme: 'basic' },
            key: { type: 'apiKey', in: 'query', name: 'k' },
            cookie: { type: 'apiKey', in: 'cookie', name: 'c' },
          },
        },
        security: [{ cookie: [] }, { basic: [] }],
        paths: {
          '/xml': { put: { requestBody: { content: { 'application/xml': { example: '<a/>' } } } } },
          '/vnd': { post: { requestBody: { content: { 'application/vnd.x+json': { examples: { one: { value: { a: 1 } } } } } } } },
          '/bin': { post: { requestBody: { content: { 'application/octet-stream': {} } } } },
          '/txt': { post: { requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } } } },
          '/q': { get: { security: [{ key: [] }] } },
        },
      },
      'https://host.example.com/specs/openapi.json',
    );
    expect(c.name).toBe('Imported API');
    expect(varOf(c, 'baseUrl')).toBe('https://host.example.com/api');
    expect(c.auth).toEqual({ type: 'basic', username: '{{username}}', password: '{{password}}' });
    const all = requests(c.items);
    expect(all.find((r) => r.url.endsWith('/xml'))?.body).toEqual({ type: 'xml', raw: '<a/>' });
    const vnd = all.find((r) => r.url.endsWith('/vnd')) as RequestItem;
    expect(vnd.body).toEqual({ type: 'json', raw: '{\n  "a": 1\n}' });
    expect(vnd.headers[0]).toEqual({ key: 'Content-Type', value: 'application/vnd.x+json', enabled: true });
    expect(all.find((r) => r.url.endsWith('/bin'))?.body).toEqual({ type: 'binary' });
    expect(all.find((r) => r.url.endsWith('/txt'))?.body).toEqual({ type: 'text', raw: 'string' });
    expect(all.find((r) => r.url.endsWith('/q'))?.auth).toEqual({ type: 'apikey', key: 'k', value: '{{apiKey}}', in: 'query' });
    expect(all[0].name).toBe('PUT /xml');
  });

  it('derives the Swagger 2 host from the spec URL when missing', () => {
    const c = convertSpec({ swagger: '2.0', info: { title: 'x' }, basePath: '/v1', paths: {} }, 'http://h.example.com:8080/spec.json');
    expect(varOf(c, 'baseUrl')).toBe('http://h.example.com:8080/v1');
  });
});

describe('generateExample', () => {
  it('handles primitives, formats, allOf, enums and depth', () => {
    expect(generateExample({ type: 'string', format: 'uuid' })).toMatch(/-/);
    expect(generateExample({ type: 'integer', minimum: 5 })).toBe(5);
    expect(generateExample({ type: 'boolean' })).toBe(true);
    expect(generateExample({ type: 'null' })).toBeNull();
    expect(generateExample({ const: 'c' })).toBe('c');
    expect(generateExample({ examples: ['first'] })).toBe('first');
    expect(generateExample({ allOf: [{ properties: { a: { type: 'integer' } } }, { properties: { b: { type: 'string' } } }] })).toEqual({ a: 0, b: 'string' });
    expect(generateExample({ allOf: [{ type: 'string' }] })).toBe('string');
    expect(generateExample({ anyOf: [{ type: 'null' }, { type: 'number' }] })).toBe(0);
    expect(generateExample({ items: { type: 'string' } })).toEqual(['string']);
    expect(generateExample({ type: 'array' })).toEqual([]);
    expect(generateExample({ properties: { w: { type: 'string', writeOnly: true } } }, 'response')).toEqual({});
    expect(generateExample({})).toBeUndefined();
    expect(generateExample(undefined)).toBeUndefined();
  });

  it('stringifies examples', () => {
    expect(exampleToString(undefined)).toBe('');
    expect(exampleToString(3)).toBe('3');
    expect(exampleToString({ a: 1 })).toBe('{"a":1}');
  });
});
