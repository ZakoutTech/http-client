import type { Auth, AuthType, KeyValue, MultipartField } from '../shared/model';
import { applyPickedFiles, duplicateField } from '../shared/multipart';
import { el, icon, iconButton, type IconName } from './dom';
import { pickFiles } from './store';
import { BTN, BTN_PRIMARY, BTN_SECONDARY, cx, FORM_GRID, HINT, KV_ROW_DISABLED, KV_TABLE, KV_WRAP, LINK_BTN, methodColor } from './ui';

export function methodBadge(method: string): HTMLElement {
  return el('span', { class: cx('inline-block min-w-[38px] shrink-0 text-right font-mono text-[10.5px] font-bold', methodColor(method)) }, [method === 'DELETE' ? 'DEL' : method === 'OPTIONS' ? 'OPT' : method]);
}

export interface KvOptions {
  noun: string;
  changed: () => void;
  rerender: () => void;
  multipart?: boolean;
  keyPlaceholder?: string;
  /** False once the table's data is no longer being edited (e.g. the user switched request); late picks are dropped. */
  isLive?: () => boolean;
}

/** Only one file dialog at a time (the OS dialog is modal; a double click must not queue a second). */
let pickInFlight = false;

/** Editable key/value table (params, headers, form fields, collection variables). */
export function kvTable(list: KeyValue[], opts: KvOptions): HTMLElement {
  const { noun, changed, rerender, multipart } = opts;
  const input = (kv: KeyValue, field: 'key' | 'value', placeholder: string) =>
    el('input', {
      type: 'text',
      value: kv[field],
      placeholder,
      spellcheck: 'false',
      'aria-label': `${noun} ${field}`,
      title: field === 'value' ? (kv.description ?? '') : '',
      oninput: (e: Event) => {
        kv[field] = (e.target as HTMLInputElement).value;
        changed();
      },
    });

  /** Value cell of a multipart File row: editable path plus a Browse… button (multi-select → array rows). */
  const fileValue = (kv: MultipartField) =>
    el('div', { class: 'flex items-center gap-1.5' }, [
      input(kv, 'value', 'Path to file (relative to workspace)'),
      el('button', {
        class: cx(BTN, BTN_SECONDARY, 'px-2 py-1'),
        type: 'button',
        title: 'Choose file(s). Picking several adds one row per file with this key (an array).',
        onclick: async (e: MouseEvent) => {
          const button = e.currentTarget as HTMLButtonElement;
          if (pickInFlight) return;
          pickInFlight = true;
          button.disabled = true;
          let paths: string[];
          try {
            paths = await pickFiles(true);
          } finally {
            pickInFlight = false;
            button.disabled = false;
          }
          if (opts.isLive && !opts.isLive()) return;
          // Look the row up again: the list may have changed while the dialog was open.
          const index = list.indexOf(kv);
          if (index < 0 || !paths.length) return;
          applyPickedFiles(list as MultipartField[], index, paths);
          changed();
          rerender();
        },
      }, [icon('paperclip', 14), 'Browse…']),
    ]);

  const rows = list.map((kv, i) =>
    el('tr', { class: kv.enabled ? '' : KV_ROW_DISABLED }, [
      el('td', { class: 'w-6' }, [
        el('input', {
          type: 'checkbox',
          checked: kv.enabled,
          'aria-label': 'Enabled',
          onchange: (e: Event) => {
            kv.enabled = (e.target as HTMLInputElement).checked;
            changed();
            rerender();
          },
        }),
      ]),
      el('td', {}, [input(kv, 'key', opts.keyPlaceholder ?? 'Key')]),
      multipart
        ? el('td', { class: 'w-[90px]' }, [
            el('select', {
              'aria-label': 'Part type',
              onchange: (e: Event) => {
                (kv as MultipartField).kind = (e.target as HTMLSelectElement).value as MultipartField['kind'];
                changed();
                rerender();
              },
            }, [
              el('option', { value: 'text', selected: (kv as MultipartField).kind !== 'file' }, ['Text']),
              el('option', { value: 'file', selected: (kv as MultipartField).kind === 'file' }, ['File']),
            ]),
          ])
        : null,
      el('td', {}, [multipart && (kv as MultipartField).kind === 'file' ? fileValue(kv as MultipartField) : input(kv, 'value', 'Value')]),
      el('td', { class: multipart ? 'w-[56px] whitespace-nowrap' : 'w-[30px]' }, [
        multipart
          ? iconButton('plus', 'Add another value for this key (sent as an array)', () => {
              duplicateField(list as MultipartField[], i);
              changed();
              rerender();
            })
          : null,
        iconButton('trash', `Remove ${noun.toLowerCase()}`, () => {
          list.splice(i, 1);
          changed();
          rerender();
        }),
      ]),
    ]),
  );

  const add = el('button', {
    class: LINK_BTN,
    type: 'button',
    onclick: () => {
      list.push(multipart ? ({ key: '', value: '', enabled: true, kind: 'text' } as MultipartField) : { key: '', value: '', enabled: true });
      changed();
      rerender();
    },
  }, [icon('plus', 14), `Add ${noun.toLowerCase()}`]);

  const head = el('thead', {}, [
    el('tr', {}, [el('th', {}), el('th', {}, ['Key']), multipart ? el('th', {}, ['Type']) : null, el('th', {}, ['Value']), el('th', {})]),
  ]);
  const hint = multipart
    ? el('p', { class: cx(HINT, 'my-0') }, ['Rows with the same key are sent as an array (one part each), e.g. ', el('code', { class: 'font-mono' }, ['files[]']), ' × 3. Use + on a row to add another value.'])
    : null;
  return el('div', { class: KV_WRAP }, [el('table', { class: KV_TABLE }, [head, el('tbody', {}, rows)]), add, hint]);
}

const AUTH_TYPES: [AuthType, string][] = [
  ['inherit', 'Inherit from parent'],
  ['none', 'No auth'],
  ['basic', 'Basic'],
  ['bearer', 'Bearer token'],
  ['apikey', 'API key'],
  ['oauth2', 'OAuth 2.0 (client credentials)'],
];

function defaultAuth(type: AuthType): Auth {
  switch (type) {
    case 'basic':
      return { type, username: '{{username}}', password: '{{password}}' };
    case 'bearer':
      return { type, token: '{{token}}' };
    case 'apikey':
      return { type, key: 'X-API-Key', value: '{{apiKey}}', in: 'header' };
    case 'oauth2':
      return { type, grant: 'client_credentials', tokenUrl: '', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', scope: '', clientAuthentication: 'header' };
    default:
      return { type } as Auth;
  }
}

/** Auth form. `allowInherit` is false for collections (the top of the chain). */
export function authEditor(get: () => Auth, set: (auth: Auth) => void, changed: () => void, rerender: () => void, allowInherit: boolean): HTMLElement {
  const a = get() as Record<string, string> & Auth;
  const field = (label: string, key: string, placeholder = '') => [
    el('label', {}, [label]),
    el('input', {
      type: 'text',
      value: a[key] ?? '',
      placeholder,
      spellcheck: 'false',
      oninput: (e: Event) => {
        a[key] = (e.target as HTMLInputElement).value;
        changed();
      },
    }),
  ];
  const select = (label: string, key: string, options: [string, string][]) => [
    el('label', {}, [label]),
    el('select', {
      onchange: (e: Event) => {
        a[key] = (e.target as HTMLSelectElement).value;
        changed();
      },
    }, options.map(([v, l]) => el('option', { value: v, selected: (a[key] ?? options[0][0]) === v }, [l]))),
  ];

  const types = AUTH_TYPES.filter(([t]) => allowInherit || t !== 'inherit');
  const grid = el('div', { class: FORM_GRID }, [
    el('label', {}, ['Type']),
    el('select', {
      onchange: (e: Event) => {
        set(defaultAuth((e.target as HTMLSelectElement).value as AuthType));
        changed();
        rerender();
      },
    }, types.map(([v, l]) => el('option', { value: v, selected: a.type === v }, [l]))),
  ]);

  switch (a.type) {
    case 'basic':
      grid.append(...field('Username', 'username', '{{username}}'), ...field('Password', 'password', '{{password}}'));
      break;
    case 'bearer':
      grid.append(...field('Token', 'token', '{{token}}'));
      break;
    case 'apikey':
      grid.append(...field('Key', 'key', 'X-API-Key'), ...field('Value', 'value', '{{apiKey}}'), ...select('Add to', 'in', [['header', 'Header'], ['query', 'Query params']]));
      break;
    case 'oauth2':
      grid.append(
        ...field('Token URL', 'tokenUrl', 'https://auth.example.com/oauth/token'),
        ...field('Client ID', 'clientId', '{{clientId}}'),
        ...field('Client secret', 'clientSecret', '{{clientSecret}}'),
        ...field('Scope', 'scope', 'read write'),
        ...select('Send credentials', 'clientAuthentication', [['header', 'As Basic auth header'], ['body', 'In request body']]),
      );
      break;
  }
  const hint =
    a.type === 'inherit'
      ? 'Uses the auth configured on the parent folder or collection.'
      : a.type === 'none'
        ? 'No Authorization header will be added.'
        : 'Tip: reference variables such as {{token}} and store their values as secrets in an environment — they are kept in VS Code SecretStorage, never in the collection file.';
  return el('div', {}, [grid, el('p', { class: HINT }, [hint])]);
}

export interface MenuItem {
  label: string;
  icon: IconName;
  run: () => void;
  danger?: boolean;
}

let openMenu: HTMLElement | undefined;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = undefined;
}

/** Small popup menu anchored at the mouse position. */
export function showMenu(event: MouseEvent, items: MenuItem[]): void {
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  const menu = el('div', { class: 'fixed z-10 min-w-[190px] rounded-md border border-menu-border bg-menu p-1 text-menu-fg shadow-[0_6px_20px_rgba(0,0,0,0.35)]', role: 'menu' }, items.map((it) =>
    el('button', {
      class: cx('flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-menu-sel hover:text-menu-sel-fg focus:bg-menu-sel focus:text-menu-sel-fg focus:outline-none', it.danger && 'text-red'),
      role: 'menuitem',
      type: 'button',
      onclick: () => {
        closeMenu();
        it.run();
      },
    }, [icon(it.icon, 14), it.label]),
  ));
  document.body.append(menu);
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 4)}px`;
  openMenu = menu;
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}

document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);

export function emptyState(iconName: IconName, title: string, text: string, actions: HTMLElement[] = []): HTMLElement {
  return el('div', { class: 'px-2.5 py-7 text-center text-muted' }, [
    el('div', { class: 'inline-flex rounded-full bg-hover p-3' }, [icon(iconName, 28)]),
    el('h3', { class: 'mt-2.5 mb-1 text-[1.17em] font-bold text-fg' }, [title]),
    el('p', { class: 'my-3' }, [text]),
    el('div', { class: 'mt-2.5 flex justify-center gap-2' }, actions),
  ]);
}

export function button(label: string, onclick: () => void, opts: { icon?: IconName; secondary?: boolean; danger?: boolean; title?: string } = {}): HTMLButtonElement {
  const cls = cx(BTN, opts.secondary ? BTN_SECONDARY : BTN_PRIMARY);
  return el('button', { class: cls, type: 'button', title: opts.title, onclick }, [opts.icon ? icon(opts.icon, 14) : null, label]);
}
