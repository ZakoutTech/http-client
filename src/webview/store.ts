import type { EnvironmentView, NavTarget, WebviewToHost, WorkbenchState } from '../shared/messages';
import type { Collection, CollectionItem, FolderItem, RequestItem, ResponseData, Variable } from '../shared/model';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(state: unknown): void };
const api = acquireVsCodeApi();

export const post = (msg: WebviewToHost): void => api.postMessage(msg);

export interface ResponseSlot {
  sending: boolean;
  response?: ResponseData;
  error?: string;
  unresolved: string[];
}

interface Persisted {
  route?: NavTarget;
  expanded?: string[];
}

const saved = (api.getState() ?? {}) as Persisted;

export const store = {
  data: null as WorkbenchState | null,
  route: (saved.route ?? { view: 'welcome' }) as NavTarget,
  expanded: new Set<string>(saved.expanded ?? []),
  search: '',
  responses: new Map<string, ResponseSlot>(),
  requestTab: 'params' as 'params' | 'headers' | 'body' | 'auth',
  responseView: 'pretty' as 'pretty' | 'raw' | 'headers',
};

export function persist(): void {
  api.setState({ route: store.route, expanded: [...store.expanded] } satisfies Persisted);
}

/** Render hooks, filled in by main.ts (avoids circular imports between views). */
export const app = {
  navigate: (_target: NavTarget): void => undefined,
  renderMain: (): void => undefined,
  renderSidebar: (): void => undefined,
};

// ---------- lookups ----------

export interface Located {
  collection: Collection;
  request: RequestItem;
  path: FolderItem[];
}

export function findRequest(requestId: string): Located | undefined {
  for (const collection of store.data?.collections ?? []) {
    const walk = (items: CollectionItem[], path: FolderItem[]): Located | undefined => {
      for (const it of items) {
        if (it.type === 'request' && it.id === requestId) return { collection, request: it, path };
        if (it.type === 'folder') {
          const found = walk(it.items, [...path, it]);
          if (found) return found;
        }
      }
      return undefined;
    };
    const found = walk(collection.items, []);
    if (found) return found;
  }
  return undefined;
}

export function findCollection(id: string): Collection | undefined {
  return store.data?.collections.find((c) => c.id === id);
}

export function findEnvironment(id: string): EnvironmentView | undefined {
  if (!store.data) return undefined;
  return id === store.data.globals.id ? store.data.globals : store.data.environments.find((e) => e.id === id);
}

export function activeEnvironment(): EnvironmentView | undefined {
  const id = store.data?.activeEnvironmentId;
  return id ? store.data?.environments.find((e) => e.id === id) : undefined;
}

export interface ScopedVariable {
  value: string;
  secret: boolean;
  source: string;
}

/** Variables visible to a request in `collection`, with precedence environment > collection > globals. */
export function variableScope(collection: Collection | undefined): Map<string, ScopedVariable> {
  const scope = new Map<string, ScopedVariable>();
  const add = (vars: (Variable & { hasValue?: boolean })[] | undefined, source: string) => {
    for (const v of vars ?? []) {
      if (v.enabled && v.key) scope.set(v.key, { value: v.secret ? (v.hasValue ? '••••••' : '') : v.value, secret: !!v.secret, source });
    }
  };
  add(store.data?.globals.variables, 'Globals');
  if (collection) add(collection.variables, `Collection · ${collection.name}`);
  const env = activeEnvironment();
  if (env) add(env.variables, `Environment · ${env.name}`);
  return scope;
}

export function countRequests(items: CollectionItem[]): number {
  return items.reduce((n, it) => n + (it.type === 'request' ? 1 : countRequests(it.items)), 0);
}

// ---------- drafts ----------

/** JSON with sorted keys, so equal objects compare equal regardless of key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/**
 * Local editable copy of a server entity. Edits are debounced to the host; while edits are
 * in flight, incoming state for this entity is ignored so typing is never clobbered.
 */
export class Draft<T> {
  value: T;
  private dirty = false;
  private lastSent = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly key: string,
    initial: T,
    private readonly save: (value: T) => void,
    private readonly normalise: (value: T) => unknown = (v) => v,
  ) {
    this.value = structuredClone(initial);
  }

  touch(delay = 300): void {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    this.lastSent = stableJson(this.normalise(this.value));
    this.save(structuredClone(this.value));
  }

  /** Reconciles with server state. Returns true when the draft adopted the server copy (caller re-renders). */
  sync(server: T): boolean {
    const serverJson = stableJson(this.normalise(server));
    if (this.dirty) {
      if (!this.timer && serverJson === this.lastSent) this.dirty = false;
      return false;
    }
    if (serverJson === stableJson(this.normalise(this.value))) return false;
    this.value = structuredClone(server);
    return true;
  }
}

/** "1 request", "3 requests". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
