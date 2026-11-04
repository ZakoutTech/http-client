import type { EnvironmentView } from '../shared/messages';
import type { Environment, Variable } from '../shared/model';

/** Converts an environment for the webview: secret values are replaced by "" plus a `hasValue` flag. */
export function toEnvironmentView(env: Environment): EnvironmentView {
  return {
    id: env.id,
    name: env.name,
    variables: env.variables.map((v) =>
      v.secret ? { key: v.key, value: '', enabled: v.enabled, secret: true, hasValue: v.value !== '' } : { ...v },
    ),
  };
}

/**
 * Applies an edit coming from the webview to a stored environment.
 * - Secret variables keep their stored value unless `secretUpdates[key]` provides a new one.
 * - A variable that just became secret keeps the plain value it had (moved into secret storage).
 * - A secret that becomes plain gets the (empty) value sent by the webview, so secrets never leak to disk.
 */
export function applyEnvironmentUpdate(
  existing: Environment,
  incoming: EnvironmentView,
  secretUpdates: Record<string, string>,
): Environment {
  const previous = new Map(existing.variables.map((v) => [v.key, v]));
  const seen = new Set<string>();
  const variables: Variable[] = [];
  for (const v of incoming.variables) {
    const key = v.key.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const old = previous.get(v.key) ?? previous.get(key);
    if (v.secret) {
      const value = Object.hasOwn(secretUpdates, v.key) ? secretUpdates[v.key] : (old?.value ?? '');
      variables.push({ key, value, enabled: v.enabled, secret: true });
    } else {
      variables.push({ key, value: v.value, enabled: v.enabled });
    }
  }
  return { version: 1, id: existing.id, name: incoming.name.trim() || existing.name, variables };
}
