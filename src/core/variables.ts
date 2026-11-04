import type { Variable } from '../shared/model';

export interface VariableScopes {
  globals?: Variable[];
  collection?: Variable[];
  environment?: Variable[];
  /** Values from the workspace .env file, available as {{$dotenv NAME}}. */
  dotenv?: Record<string, string>;
}

export interface ResolverDeps {
  now?: () => Date;
  random?: () => number;
  uuid?: () => string;
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 10;

/**
 * Resolves {{name}} templates. Precedence (highest first):
 * dynamic ($...) → environment → collection → globals.
 * Unresolvable templates are left untouched and recorded in `unresolved`.
 */
export class VariableResolver {
  readonly unresolved = new Set<string>();
  private readonly values = new Map<string, string>();
  private readonly dotenv: Record<string, string>;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly uuid: () => string;

  constructor(scopes: VariableScopes, deps: ResolverDeps = {}) {
    for (const scope of [scopes.globals, scopes.collection, scopes.environment]) {
      for (const v of scope ?? []) {
        if (v.enabled && v.key) this.values.set(v.key, v.value);
      }
    }
    this.dotenv = scopes.dotenv ?? {};
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());
  }

  /** Names of all statically defined variables (for autocomplete / UI hints). */
  names(): string[] {
    return [...this.values.keys()].sort();
  }

  resolve(text: string): string {
    return this.resolveText(text, 0, []);
  }

  private resolveText(text: string, depth: number, stack: string[]): string {
    if (!text || !text.includes('{{')) return text;
    return text.replace(TEMPLATE, (whole, expr: string) => {
      const value = this.lookup(expr.trim(), depth, stack);
      if (value === undefined) {
        this.unresolved.add(expr.trim());
        return whole;
      }
      return value;
    });
  }

  private lookup(expr: string, depth: number, stack: string[]): string | undefined {
    if (expr.startsWith('$')) return this.dynamic(expr);
    if (!this.values.has(expr)) return undefined;
    if (depth >= MAX_DEPTH || stack.includes(expr)) return undefined; // cycle or too deep
    return this.resolveText(this.values.get(expr) as string, depth + 1, [...stack, expr]);
  }

  private dynamic(expr: string): string | undefined {
    const [name, ...args] = expr.split(/\s+/);
    switch (name) {
      case '$uuid':
      case '$guid':
        return this.uuid();
      case '$timestamp':
        return String(Math.floor(this.now().getTime() / 1000));
      case '$isoTimestamp':
        return this.now().toISOString();
      case '$randomInt': {
        const min = args[0] !== undefined ? Number(args[0]) : 0;
        const max = args[1] !== undefined ? Number(args[1]) : 1000;
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined;
        return String(Math.floor(this.random() * (max - min)) + min);
      }
      case '$dotenv': {
        const key = args[0];
        return key !== undefined && Object.hasOwn(this.dotenv, key) ? this.dotenv[key] : undefined;
      }
      default:
        return undefined;
    }
  }
}
