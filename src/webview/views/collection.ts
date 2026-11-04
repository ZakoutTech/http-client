import type { CollectionPatch, CollectionTab } from '../../shared/messages';
import type { Auth, Collection, CollectionItem, Variable } from '../../shared/model';
import { authEditor, button, emptyState, kvTable, methodBadge } from '../components';
import { el, icon, iconButton } from '../dom';
import { app, countRequests, Draft, findCollection, post, store } from '../store';
import { BADGE, cx, FIELD_LABEL, HEADER_ACTIONS, HEADER_ICON, HINT_TOP, LINK_BTN, LIST_TABLE, PAGE, SECTION_HEADING, tab as tabClass, TABS, TITLE_INPUT, VIEW_HEADER } from '../ui';

interface Settings {
  name: string;
  description: string;
  variables: Variable[];
  auth: Auth;
}

let draft: Draft<Settings> | undefined;

const settingsOf = (c: Collection): Settings => ({ name: c.name, description: c.description ?? '', variables: c.variables, auth: c.auth });

function ensureDraft(c: Collection): Draft<Settings> {
  if (!draft || draft.key !== c.id) {
    draft?.flush();
    draft = new Draft<Settings>(c.id, settingsOf(c), (s) =>
      post({ type: 'updateCollection', collectionId: c.id, patch: { name: s.name, description: s.description, variables: s.variables, auth: s.auth } satisfies CollectionPatch }),
    );
  }
  return draft;
}

export function syncCollectionView(collectionId: string): boolean {
  const c = findCollection(collectionId);
  if (!c) return true;
  ensureDraft(c).sync(settingsOf(c));
  return true; // the request list and counts always reflect server state
}

export function flushCollectionDraft(): void {
  draft?.flush();
}

function flatRequests(items: CollectionItem[], path: string[] = []): { item: Extract<CollectionItem, { type: 'request' }>; path: string[] }[] {
  return items.flatMap((it) => (it.type === 'request' ? [{ item: it, path }] : flatRequests(it.items, [...path, it.name])));
}

function countFolders(items: CollectionItem[]): number {
  return items.reduce((n, it) => n + (it.type === 'folder' ? 1 + countFolders(it.items) : 0), 0);
}

export function renderCollectionView(container: HTMLElement, collectionId: string, tab: CollectionTab): void {
  const c = findCollection(collectionId);
  if (!c) {
    container.replaceChildren(emptyState('collection', 'Collection not found', 'It may have been deleted.', []));
    return;
  }
  const d = ensureDraft(c);
  const s = d.value;
  const changed = () => d.touch();
  const rerender = () => renderCollectionView(container, collectionId, tab);
  const go = (t: CollectionTab) => app.navigate({ view: 'collection', collectionId, tab: t });

  const root = el('section', { class: PAGE });
  container.replaceChildren(root);
  root.append(
    el('div', { class: VIEW_HEADER }, [
      el('span', { class: HEADER_ICON }, [icon('collection', 18)]),
      el('input', {
        class: TITLE_INPUT,
        type: 'text',
        value: s.name,
        'aria-label': 'Collection name',
        oninput: (e: Event) => {
          s.name = (e.target as HTMLInputElement).value;
          changed();
        },
        onchange: () => app.renderSidebar(),
      }),
      el('div', { class: HEADER_ACTIONS }, [
        button('New request', () => post({ type: 'itemAction', action: 'newRequest', collectionId }), { icon: 'plus' }),
        iconButton('folderPlus', 'New folder', () => post({ type: 'itemAction', action: 'newFolder', collectionId })),
        iconButton('copy', 'Duplicate collection', () => post({ type: 'itemAction', action: 'duplicate', collectionId })),
        iconButton('trash', 'Delete collection', () => post({ type: 'itemAction', action: 'delete', collectionId })),
      ]),
    ]),
  );

  const tabs: [CollectionTab, string, string?][] = [
    ['overview', 'Overview'],
    ['variables', 'Variables', String(s.variables.length)],
    ['auth', 'Auth', s.auth.type],
  ];
  root.append(
    el('div', { class: TABS, role: 'tablist' }, tabs.map(([id, label, badge]) =>
      el('button', { class: tabClass(tab === id), role: 'tab', type: 'button', 'aria-selected': String(tab === id), onclick: () => go(id) }, [
        label,
        badge ? el('span', { class: cx(BADGE, 'lowercase') }, [badge]) : null,
      ]),
    )),
  );

  const panel = el('div');
  root.append(panel);

  if (tab === 'overview') {
    const requests = flatRequests(c.items);
    const description = el('textarea', {
      class: 'min-h-[60px]',
      placeholder: 'Describe this API…',
      'aria-label': 'Description',
      oninput: (e: Event) => {
        s.description = (e.target as HTMLTextAreaElement).value;
        changed();
      },
    });
    description.value = s.description;
    panel.append(
      el('div', { class: 'mb-4 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5' }, [
        stat('Requests', String(countRequests(c.items)), 'send'),
        stat('Folders', String(countFolders(c.items)), 'folder'),
        stat('Variables', String(c.variables.filter((v) => v.enabled).length), 'braces', () => go('variables')),
        stat('Auth', c.auth.type === 'none' ? 'None' : c.auth.type, 'lock', () => go('auth')),
      ]),
      el('label', { class: FIELD_LABEL }, ['Description']),
      description,
      el('h3', { class: SECTION_HEADING }, ['Requests']),
      requests.length
        ? el('table', { class: cx(LIST_TABLE, '[&_td]:py-[7px]') }, [
            el('tbody', {}, requests.map(({ item, path }) =>
              el('tr', { class: 'cursor-pointer hover:bg-hover', tabindex: '0', onclick: () => app.navigate({ view: 'request', requestId: item.id }), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && app.navigate({ view: 'request', requestId: item.id }) }, [
                el('td', { class: 'w-[54px]' }, [methodBadge(item.method)]),
                el('td', { class: 'whitespace-nowrap' }, [item.name, path.length ? el('span', { class: 'ml-2 text-[0.88em] text-muted' }, [path.join(' › ')]) : null]),
                el('td', { class: 'w-[55%] max-w-0 truncate font-mono text-muted' }, [item.url]),
              ]),
            )),
          ])
        : emptyState('send', 'No requests yet', 'Add a request or import an OpenAPI document.', [
            button('New request', () => post({ type: 'itemAction', action: 'newRequest', collectionId }), { icon: 'plus' }),
          ]),
    );
  } else if (tab === 'variables') {
    panel.append(
      el('p', { class: HINT_TOP }, [
        'Collection variables are saved in the collection file (shared via git). Environment variables override them; keep credentials in an environment as ',
        el('strong', {}, ['secrets']),
        '. ',
        el('button', { class: LINK_BTN, type: 'button', onclick: () => app.navigate({ view: 'variables', environmentId: store.data?.activeEnvironmentId ?? undefined }) }, ['Open environments']),
      ]),
      kvTable(s.variables as Variable[], { noun: 'Variable', changed, rerender, keyPlaceholder: 'baseUrl' }),
    );
  } else {
    panel.append(
      el('p', { class: HINT_TOP }, ['Requests and folders set to “Inherit” use this auth.']),
      authEditor(() => s.auth, (a) => (s.auth = a), changed, rerender, false),
    );
  }
}

function stat(label: string, value: string, iconName: Parameters<typeof icon>[0], onclick?: () => void): HTMLElement {
  const cls = cx(
    'grid grid-cols-[auto_1fr] grid-rows-[auto_auto] items-center gap-x-2.5 rounded-md border border-line bg-fg/[3%] px-3 py-2.5 text-left',
    onclick && 'hover:border-accent',
  );
  return el(onclick ? 'button' : 'div', { class: cls, type: onclick ? 'button' : undefined, onclick }, [
    el('span', { class: 'row-span-2 inline-flex text-accent' }, [icon(iconName, 16)]),
    el('span', { class: 'text-[1.3em] font-bold capitalize' }, [value]),
    el('span', { class: 'text-[0.88em] text-muted' }, [label]),
  ]);
}
