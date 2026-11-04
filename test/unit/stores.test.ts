import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollectionStore, parseCollection } from '../../src/core/collectionStore';
import { EnvironmentStore, GLOBALS_ID, secretKey, type SecretProvider } from '../../src/core/environmentStore';
import { newRequest, type Collection } from '../../src/shared/model';

class MemorySecrets implements SecretProvider {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key);
  }
  async store(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'httpclient-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const collection = (id: string, name: string): Collection => ({
  version: 1,
  id,
  name,
  variables: [],
  auth: { type: 'none' },
  items: [newRequest(`${id}-r`, 'Req')],
});

describe('CollectionStore', () => {
  it('returns nothing when the folder does not exist', async () => {
    expect(await new CollectionStore(root).load()).toEqual([]);
  });

  it('round-trips collections to pretty JSON files with stable names', async () => {
    const store = new CollectionStore(root);
    await store.save(collection('a', 'My API'));
    await store.save(collection('b', 'My API'));
    const files = (await readdir(store.dir)).sort();
    expect(files).toEqual(['my-api-2.json', 'my-api.json']);

    const c = store.get('a') as Collection;
    c.name = 'Renamed';
    await store.save(c);
    expect((await readdir(store.dir)).sort()).toEqual(files); // file name is stable on rename

    const text = await readFile(join(store.dir, 'my-api.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "name": "Renamed"');

    const fresh = new CollectionStore(root);
    const loaded = await fresh.load();
    expect(loaded.map((x) => x.name)).toEqual(['My API', 'Renamed']);
    expect(fresh.fileOf('a')).toBe(join(store.dir, 'my-api.json'));
  });

  it('deletes collections and tolerates already-missing files', async () => {
    const store = new CollectionStore(root);
    await store.save(collection('a', 'A'));
    await rm(store.fileOf('a') as string);
    await store.delete('a');
    expect(store.get('a')).toBeUndefined();
    await store.delete('never-existed');
  });

  it('reports invalid and duplicate files without failing the load', async () => {
    const store = new CollectionStore(root);
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'bad.json'), '{ nope');
    await writeFile(join(store.dir, 'old.json'), JSON.stringify({ version: 2, id: 'x', name: 'x', items: [] }));
    await writeFile(join(store.dir, 'one.json'), JSON.stringify(collection('dup', 'One')));
    await writeFile(join(store.dir, 'two.json'), JSON.stringify(collection('dup', 'Two')));
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(store.errors.map((e) => e.message).join('|')).toMatch(/JSON|unsupported version 2|duplicate/);
    expect(store.errors).toHaveLength(3);
  });

  it('normalises missing optional fields', () => {
    const parsed = parseCollection({
      version: 1,
      id: 'c',
      name: 'C',
      items: [{ type: 'folder', id: 'f', name: 'F', items: [{ type: 'request', id: 'r', name: 'R', method: 'GET', url: '/' }] }],
    });
    expect(parsed.auth).toEqual({ type: 'none' });
    expect(parsed.variables).toEqual([]);
    const folder = parsed.items[0];
    const req = folder.type === 'folder' ? folder.items[0] : undefined;
    expect(req).toMatchObject({ params: [], headers: [], body: { type: 'none' }, auth: { type: 'inherit' } });
    expect(() => parseCollection(null)).toThrow();
    expect(() => parseCollection({ version: 1, name: 'x', items: [] })).toThrow(/id/);
    expect(() => parseCollection({ version: 1, id: 'x', name: 'x', items: [{ type: 'weird' }] })).toThrow(/items/);
  });
});

describe('EnvironmentStore', () => {
  it('never writes secret values to disk and restores them from the secret provider', async () => {
    const secrets = new MemorySecrets();
    const store = new EnvironmentStore(root, secrets);
    await store.load();
    await store.save({
      version: 1,
      id: 'dev',
      name: 'Dev',
      variables: [
        { key: 'baseUrl', value: 'http://localhost', enabled: true },
        { key: 'token', value: 'TOP-SECRET-VALUE', enabled: true, secret: true },
      ],
    });

    const files = await readdir(store.dir);
    const onDisk = await readFile(join(store.dir, files[0]), 'utf8');
    expect(onDisk).not.toContain('TOP-SECRET-VALUE');
    expect(JSON.parse(onDisk).variables[1]).toEqual({ key: 'token', value: '', enabled: true, secret: true });
    expect(secrets.data.get(secretKey('dev', 'token'))).toBe('TOP-SECRET-VALUE');

    const fresh = new EnvironmentStore(root, secrets);
    await fresh.load();
    expect(fresh.get('dev')?.variables[1].value).toBe('TOP-SECRET-VALUE');
  });

  it('removes secrets when a variable stops being secret or the environment is deleted', async () => {
    const secrets = new MemorySecrets();
    const store = new EnvironmentStore(root, secrets);
    await store.load();
    await store.save({ version: 1, id: 'e', name: 'E', variables: [{ key: 'k', value: 'v', enabled: true, secret: true }] });
    await store.save({ version: 1, id: 'e', name: 'E', variables: [{ key: 'k', value: 'v', enabled: true }] });
    expect(secrets.data.size).toBe(0);
    await store.save({ version: 1, id: 'e', name: 'E', variables: [{ key: 'k', value: 'v', enabled: true, secret: true }] });
    await store.delete('e');
    expect(secrets.data.size).toBe(0);
    expect(store.list()).toEqual([]);
    await store.delete('unknown');
  });

  it('stores globals in globals.json and skips unreadable environment files', async () => {
    const store = new EnvironmentStore(root, new MemorySecrets());
    await store.load();
    expect(store.getGlobals().variables).toEqual([]);
    await store.save({ version: 1, id: GLOBALS_ID, name: 'Globals', variables: [{ key: 'g', value: '1', enabled: true }] });
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'broken.json'), 'not json');
    await writeFile(join(store.dir, 'noid.json'), JSON.stringify({ name: 'x' }));

    const fresh = new EnvironmentStore(root, new MemorySecrets());
    await fresh.load();
    expect(fresh.get(GLOBALS_ID)?.variables).toEqual([{ key: 'g', value: '1', enabled: true }]);
    expect(fresh.list()).toEqual([]);
  });
});

describe('stores stay inside the workspace', () => {
  let outside: string;
  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'httpclient-outside-'));
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  it('skips collection files that are symlinks to outside the workspace', async () => {
    await writeFile(join(outside, 'evil.json'), JSON.stringify(collection('evil', 'Evil')));
    const dir = join(root, '.httpclient', 'collections');
    await mkdir(dir, { recursive: true });
    await symlink(join(outside, 'evil.json'), join(dir, 'evil.json'));
    const store = new CollectionStore(root);
    expect(await store.load()).toEqual([]);
    expect(store.errors[0].message).toMatch(/outside the workspace/);
  });

  it('refuses to read or write through a .httpclient folder symlinked outside the workspace', async () => {
    await mkdir(join(outside, 'collections'), { recursive: true });
    await writeFile(join(outside, 'collections', 'a.json'), JSON.stringify(collection('a', 'A')));
    await symlink(outside, join(root, '.httpclient'));
    const store = new CollectionStore(root);
    expect(await store.load()).toEqual([]);
    await expect(store.save(collection('b', 'B'))).rejects.toThrow(/outside the workspace/);
    expect(await readdir(join(outside, 'collections'))).toEqual(['a.json']);

    const envs = new EnvironmentStore(root, new MemorySecrets());
    await expect(envs.load()).rejects.toThrow(/outside the workspace/);
  });
});
