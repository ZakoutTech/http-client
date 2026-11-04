import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Environment, Variable } from '../shared/model';
import { slugify } from '../shared/ids';
import { DATA_DIR } from './collectionStore';
import { isEnoent, readJson, writeJsonAtomic } from './fsJson';

/** Abstraction over VS Code SecretStorage so the store stays testable. */
export interface SecretProvider {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const GLOBALS_ID = 'globals';

export const secretKey = (envId: string, varKey: string) => `httpClient:${envId}:${varKey}`;

function parseVariables(raw: unknown): Variable[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && typeof v.key === 'string')
    .map((v) => ({
      key: v.key as string,
      value: typeof v.value === 'string' ? v.value : '',
      enabled: v.enabled !== false,
      ...(v.secret === true ? { secret: true } : {}),
    }));
}

/**
 * Environments live in `<root>/.httpclient/environments/*.json`, globals in `<root>/.httpclient/globals.json`.
 * Secret variable values are kept only in the SecretProvider; on disk they are always "".
 */
export class EnvironmentStore {
  private readonly envs = new Map<string, Environment>();
  private readonly files = new Map<string, string>();
  private globals: Environment = { version: 1, id: GLOBALS_ID, name: 'Globals', variables: [] };

  constructor(
    readonly rootDir: string,
    private readonly secrets: SecretProvider,
  ) {}

  get dir(): string {
    return join(this.rootDir, DATA_DIR, 'environments');
  }

  get globalsFile(): string {
    return join(this.rootDir, DATA_DIR, 'globals.json');
  }

  async load(): Promise<void> {
    this.envs.clear();
    this.files.clear();
    this.globals = await this.readEnv(this.globalsFile, GLOBALS_ID, 'Globals');
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json')).sort();
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    for (const name of names) {
      const file = join(this.dir, name);
      try {
        const env = await this.readEnv(file);
        if (env.id === GLOBALS_ID || this.envs.has(env.id)) continue;
        this.envs.set(env.id, env);
        this.files.set(env.id, file);
      } catch {
        // Skip unreadable files; they stay untouched on disk.
      }
    }
  }

  private async readEnv(file: string, fallbackId?: string, fallbackName?: string): Promise<Environment> {
    let raw: Record<string, unknown> = {};
    try {
      raw = (await readJson(file, this.rootDir)) as Record<string, unknown>;
    } catch (err) {
      if (!isEnoent(err) || !fallbackId) throw err;
    }
    const id = fallbackId ?? (typeof raw.id === 'string' ? raw.id : undefined);
    const name = typeof raw.name === 'string' ? raw.name : fallbackName;
    if (!id || !name) throw new Error(`invalid environment file ${file}`);
    const variables = parseVariables(raw.variables);
    for (const v of variables) {
      if (v.secret) v.value = (await this.secrets.get(secretKey(id, v.key))) ?? '';
    }
    return { version: 1, id, name, variables };
  }

  list(): Environment[] {
    return [...this.envs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Environment | undefined {
    return id === GLOBALS_ID ? this.globals : this.envs.get(id);
  }

  getGlobals(): Environment {
    return this.globals;
  }

  /** Persists an environment (or globals). Secret values go to the SecretProvider only. */
  async save(env: Environment): Promise<void> {
    const previous = this.get(env.id);
    for (const v of env.variables) {
      if (v.secret) await this.secrets.store(secretKey(env.id, v.key), v.value);
    }
    // Drop secrets for variables that were removed or are no longer secret.
    for (const old of previous?.variables ?? []) {
      if (old.secret && !env.variables.some((v) => v.key === old.key && v.secret)) {
        await this.secrets.delete(secretKey(env.id, old.key));
      }
    }
    const onDisk: Environment = {
      ...env,
      variables: env.variables.map((v) => (v.secret ? { ...v, value: '' } : v)),
    };
    if (env.id === GLOBALS_ID) {
      await writeJsonAtomic(this.globalsFile, onDisk, this.rootDir);
      this.globals = env;
      return;
    }
    const file = this.files.get(env.id) ?? this.uniqueFile(env.name);
    await writeJsonAtomic(file, onDisk, this.rootDir);
    this.envs.set(env.id, env);
    this.files.set(env.id, file);
  }

  async delete(id: string): Promise<void> {
    const env = this.envs.get(id);
    const file = this.files.get(id);
    if (!env || !file) return;
    for (const v of env.variables) if (v.secret) await this.secrets.delete(secretKey(id, v.key));
    try {
      await unlink(file);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    this.envs.delete(id);
    this.files.delete(id);
  }

  private uniqueFile(name: string): string {
    const used = new Set(this.files.values());
    const base = slugify(name);
    let candidate = join(this.dir, `${base}.json`);
    for (let i = 2; used.has(candidate); i++) candidate = join(this.dir, `${base}-${i}.json`);
    return candidate;
  }
}
