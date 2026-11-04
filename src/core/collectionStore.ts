import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Collection, CollectionItem, Variable } from '../shared/model';
import { slugify } from '../shared/ids';
import { isEnoent, readJson, writeJsonAtomic } from './fsJson';

export const DATA_DIR = '.httpclient';

export interface LoadError {
  file: string;
  message: string;
}

function isItem(v: unknown): v is CollectionItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false;
  if (o.type === 'folder') return Array.isArray(o.items) && o.items.every(isItem);
  return o.type === 'request' && typeof o.url === 'string' && typeof o.method === 'string';
}

/** Validates and normalises a parsed collection file. Throws on structural errors. */
export function parseCollection(raw: unknown): Collection {
  if (typeof raw !== 'object' || raw === null) throw new Error('not an object');
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new Error(`unsupported version ${String(o.version)}`);
  if (typeof o.id !== 'string' || typeof o.name !== 'string') throw new Error('missing id or name');
  if (!Array.isArray(o.items) || !o.items.every(isItem)) throw new Error('invalid items');
  const normaliseRequest = (it: CollectionItem): CollectionItem => {
    if (it.type === 'folder') return { ...it, items: it.items.map(normaliseRequest) };
    return {
      ...it,
      params: it.params ?? [],
      headers: it.headers ?? [],
      body: it.body ?? { type: 'none' },
      auth: it.auth ?? { type: 'inherit' },
    };
  };
  return {
    version: 1,
    id: o.id,
    name: o.name,
    description: typeof o.description === 'string' ? o.description : undefined,
    variables: Array.isArray(o.variables) ? (o.variables as Variable[]) : [],
    auth: (o.auth as Collection['auth']) ?? { type: 'none' },
    items: (o.items as CollectionItem[]).map(normaliseRequest),
  };
}

/** Reads and writes `<root>/.httpclient/collections/*.json`, one file per collection. */
export class CollectionStore {
  private readonly files = new Map<string, string>();
  private readonly collections = new Map<string, Collection>();
  readonly errors: LoadError[] = [];

  constructor(readonly rootDir: string) {}

  get dir(): string {
    return join(this.rootDir, DATA_DIR, 'collections');
  }

  async load(): Promise<Collection[]> {
    this.files.clear();
    this.collections.clear();
    this.errors.length = 0;
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json')).sort();
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    for (const name of names) {
      const file = join(this.dir, name);
      try {
        const collection = parseCollection(await readJson(file, this.rootDir));
        if (this.collections.has(collection.id)) throw new Error(`duplicate collection id ${collection.id}`);
        this.collections.set(collection.id, collection);
        this.files.set(collection.id, file);
      } catch (err) {
        this.errors.push({ file, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.list();
  }

  list(): Collection[] {
    return [...this.collections.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Collection | undefined {
    return this.collections.get(id);
  }

  fileOf(id: string): string | undefined {
    return this.files.get(id);
  }

  private uniqueFile(name: string): string {
    const used = new Set(this.files.values());
    const base = slugify(name);
    let candidate = join(this.dir, `${base}.json`);
    for (let i = 2; used.has(candidate); i++) candidate = join(this.dir, `${base}-${i}.json`);
    return candidate;
  }

  /** Saves a collection; new collections get a file named after their slug. File names stay stable on rename. */
  async save(collection: Collection): Promise<string> {
    const file = this.files.get(collection.id) ?? this.uniqueFile(collection.name);
    await writeJsonAtomic(file, collection, this.rootDir);
    this.collections.set(collection.id, collection);
    this.files.set(collection.id, file);
    return file;
  }

  async delete(id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) return;
    try {
      await unlink(file);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    this.files.delete(id);
    this.collections.delete(id);
  }
}
