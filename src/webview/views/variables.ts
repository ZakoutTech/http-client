import type { EnvironmentView, VariableView } from '../../shared/messages';
import { button, emptyState } from '../components';
import { el, icon, iconButton } from '../dom';
import { activeEnvironment, app, Draft, findEnvironment, post, store, plural, variableScope } from '../store';

let draft: Draft<EnvironmentView> | undefined;
let secretUpdates: Record<string, string> = {};

/** hasValue is server-computed; ignore it when comparing drafts. */
const normalise = (env: EnvironmentView) => ({ ...env, variables: env.variables.map(({ hasValue: _h, ...v }) => v) });

function ensureDraft(env: EnvironmentView): Draft<EnvironmentView> {
  if (!draft || draft.key !== env.id) {
    draft?.flush();
    secretUpdates = {};
    draft = new Draft(
      env.id,
      env,
      (value) => {
        const updates = secretUpdates;
        secretUpdates = {};
        post({ type: 'saveEnvironment', environment: value, secretUpdates: updates });
      },
      normalise,
    );
  }
  return draft;
}

export function syncVariablesView(environmentId: string | undefined): boolean {
  const env = findEnvironment(environmentId ?? store.data?.globals.id ?? '');
  if (!env) return true;
  const d = ensureDraft(env);
  const adopted = d.sync(env);
  // Keep hasValue flags fresh even while editing.
  for (const v of d.value.variables) v.hasValue = env.variables.find((x) => x.key === v.key)?.hasValue ?? v.hasValue;
  return adopted;
}

export function flushVariablesDraft(): void {
  draft?.flush();
}

export function renderVariablesView(container: HTMLElement, environmentId: string | undefined): void {
  const data = store.data;
  if (!data) return;
  const selectedId = environmentId && findEnvironment(environmentId) ? environmentId : data.globals.id;
  const env = findEnvironment(selectedId) as EnvironmentView;
  const isGlobals = selectedId === data.globals.id;

  const list = el('nav', { class: 'env-list', 'aria-label': 'Environments' }, [
    el('div', { class: 'env-list-head' }, [
      el('span', { class: 'section-title' }, ['Scopes']),
      iconButton('plus', 'New environment', () => post({ type: 'action', action: 'newEnvironment' })),
    ]),
    envRow(data.globals, 'globe', 'Globals', 'Always applied', selectedId),
    el('div', { class: 'env-list-sub' }, ['Environments']),
    ...data.environments.map((e) =>
      envRow(e, 'layers', e.name, e.id === data.activeEnvironmentId ? 'Active' : plural(e.variables.length, 'variable'), selectedId, e.id === data.activeEnvironmentId),
    ),
    data.environments.length ? null : el('p', { class: 'muted pad' }, ['No environments yet.']),
    button('New environment', () => post({ type: 'action', action: 'newEnvironment' }), { icon: 'plus', secondary: true }),
  ]);

  const editor = el('section', { class: 'env-editor' });
  container.replaceChildren(el('div', { class: 'variables-layout' }, [list, editor]));
  renderEditor(editor, env, isGlobals);
}

function envRow(env: EnvironmentView, iconName: 'globe' | 'layers', label: string, sub: string, selectedId: string, active = false): HTMLElement {
  return el('button', {
    class: `env-row${env.id === selectedId ? ' selected' : ''}`,
    type: 'button',
    onclick: () => app.navigate({ view: 'variables', environmentId: env.id }),
  }, [
    icon(iconName, 15),
    el('span', { class: 'env-name' }, [label]),
    active ? el('span', { class: 'badge active' }, ['Active']) : el('span', { class: 'muted small' }, [sub]),
  ]);
}

function renderEditor(root: HTMLElement, env: EnvironmentView, isGlobals: boolean): void {
  const d = ensureDraft(env);
  const e = d.value;
  const changed = () => d.touch();
  const rerender = () => renderEditor(root, env, isGlobals);
  const isActive = store.data?.activeEnvironmentId === env.id;

  root.replaceChildren(
    el('div', { class: 'view-header' }, [
      el('span', { class: 'header-icon' }, [icon(isGlobals ? 'globe' : 'layers', 18)]),
      isGlobals
        ? el('h2', { class: 'title' }, ['Globals'])
        : el('input', {
            class: 'title-input',
            type: 'text',
            value: e.name,
            'aria-label': 'Environment name',
            oninput: (ev: Event) => {
              e.name = (ev.target as HTMLInputElement).value;
              changed();
            },
          }),
      el('div', { class: 'header-actions' }, isGlobals
        ? []
        : [
            isActive
              ? button('Deactivate', () => post({ type: 'setActiveEnvironment', environmentId: null }), { secondary: true })
              : button('Set active', () => post({ type: 'setActiveEnvironment', environmentId: env.id }), { icon: 'check' }),
            iconButton('copy', 'Duplicate environment', () => post({ type: 'envAction', action: 'duplicate', environmentId: env.id })),
            iconButton('trash', 'Delete environment', () => post({ type: 'envAction', action: 'delete', environmentId: env.id })),
          ]),
    ]),
    el('p', { class: 'hint top' }, [
      isGlobals ? 'Globals apply to every request. ' : 'Environment values override collection variables and globals while this environment is active. ',
      'Mark credentials as ',
      el('strong', {}, ['secret']),
      ' — they are stored in VS Code SecretStorage and written to disk as an empty value.',
    ]),
    variablesTable(e.variables, changed, rerender),
    resolutionPreview(),
  );
}

function variablesTable(vars: VariableView[], changed: () => void, rerender: () => void): HTMLElement {
  const rows = vars.map((v, i) => {
    const valueInput = v.secret
      ? el('input', {
          type: 'password',
          value: secretUpdates[v.key] ?? '',
          placeholder: v.hasValue ? '•••••••• stored securely — type to replace' : 'Enter secret value',
          autocomplete: 'off',
          'aria-label': `Secret value of ${v.key}`,
          oninput: (ev: Event) => {
            secretUpdates[v.key] = (ev.target as HTMLInputElement).value;
            changed();
          },
        })
      : el('input', {
          type: 'text',
          value: v.value,
          placeholder: 'Value',
          spellcheck: 'false',
          'aria-label': `Value of ${v.key}`,
          oninput: (ev: Event) => {
            v.value = (ev.target as HTMLInputElement).value;
            changed();
          },
        });
    return el('tr', { class: v.enabled ? '' : 'disabled' }, [
      el('td', { class: 'check' }, [
        el('input', {
          type: 'checkbox',
          checked: v.enabled,
          'aria-label': 'Enabled',
          onchange: (ev: Event) => {
            v.enabled = (ev.target as HTMLInputElement).checked;
            changed();
            rerender();
          },
        }),
      ]),
      el('td', {}, [
        el('input', {
          type: 'text',
          value: v.key,
          placeholder: 'name',
          spellcheck: 'false',
          'aria-label': 'Variable name',
          oninput: (ev: Event) => {
            const next = (ev.target as HTMLInputElement).value;
            if (Object.hasOwn(secretUpdates, v.key)) {
              secretUpdates[next] = secretUpdates[v.key];
              delete secretUpdates[v.key];
            }
            v.key = next;
            changed();
          },
        }),
      ]),
      el('td', {}, [valueInput]),
      el('td', { class: 'secret-cell' }, [
        el('button', {
          class: `secret-toggle${v.secret ? ' on' : ''}`,
          type: 'button',
          role: 'switch',
          'aria-checked': String(!!v.secret),
          title: v.secret ? 'Secret — click to make plain (clears the value)' : 'Plain — click to store as a secret',
          onclick: () => {
            if (v.secret) {
              v.secret = false;
              v.value = '';
              delete secretUpdates[v.key];
            } else {
              v.secret = true;
              if (v.value) secretUpdates[v.key] = v.value;
              v.hasValue = !!v.value;
              v.value = '';
            }
            changed();
            rerender();
          },
        }, [icon(v.secret ? 'lock' : 'unlock', 14), v.secret ? 'Secret' : 'Plain']),
      ]),
      el('td', { class: 'del' }, [
        iconButton('trash', 'Delete variable', () => {
          vars.splice(i, 1);
          delete secretUpdates[v.key];
          changed();
          rerender();
        }),
      ]),
    ]);
  });

  return el('div', { class: 'kv-wrap' }, [
    vars.length
      ? el('table', { class: 'kv' }, [
          el('thead', {}, [el('tr', {}, [el('th', {}), el('th', {}, ['Variable']), el('th', {}, ['Value']), el('th', {}, ['Type']), el('th', {})])]),
          el('tbody', {}, rows),
        ])
      : el('p', { class: 'muted' }, ['No variables yet.']),
    el('button', {
      class: 'link-btn',
      type: 'button',
      onclick: () => {
        vars.push({ key: '', value: '', enabled: true });
        changed();
        rerender();
        const inputs = document.querySelectorAll<HTMLInputElement>('.env-editor table.kv tbody tr:last-child input[type="text"]');
        inputs[0]?.focus();
      },
    }, [icon('plus', 14), 'Add variable']),
  ]);
}

/** Shows the effective value of every global/environment variable and where it comes from. */
function resolutionPreview(): HTMLElement {
  const env = activeEnvironment();
  const scope = variableScope(undefined);
  const rows = [...scope.entries()].sort(([a], [b]) => a.localeCompare(b));
  return el('div', { class: 'card' }, [
    el('h3', { class: 'section' }, [icon('braces', 15), 'Effective values', el('span', { class: 'muted small' }, [` — active environment: ${env?.name ?? 'none'}`])]),
    el('p', { class: 'hint' }, ['Precedence: Environment › Collection › Globals. Collection variables are edited in each collection’s settings.']),
    rows.length
      ? el('table', { class: 'list compact' }, [
          el('tbody', {}, rows.map(([name, v]) =>
            el('tr', {}, [
              el('td', { class: 'mono' }, [`{{${name}}}`]),
              el('td', { class: 'mono' }, [v.secret ? el('span', { class: 'muted' }, [icon('lock', 12), v.value ? ' secret' : ' secret (empty)']) : v.value || el('span', { class: 'muted' }, ['(empty)'])]),
              el('td', { class: 'muted' }, [v.source]),
            ]),
          )),
        ])
      : emptyState('braces', 'Nothing defined yet', 'Add variables to Globals or an environment.'),
    store.data?.dotenvKeys.length
      ? el('p', { class: 'hint' }, ['From .env: ', ...store.data.dotenvKeys.map((k) => el('code', { class: 'chip dynamic' }, [`{{$dotenv ${k}}}`]))])
      : null,
  ]);
}
