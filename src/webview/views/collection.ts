import type { CollectionPatch, CollectionTab } from '../../shared/messages';
import type { Auth, Collection, CollectionItem, Variable } from '../../shared/model';
import { authEditor, button, emptyState, kvTable, methodBadge } from '../components';
import { el, icon, iconButton } from '../dom';
import { app, countRequests, Draft, findCollection, post, store } from '../store';

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

  const root = el('section', { class: 'page' });
  container.replaceChildren(root);
  root.append(
    el('div', { class: 'view-header' }, [
      el('span', { class: 'header-icon' }, [icon('collection', 18)]),
      el('input', {
        class: 'title-input',
        type: 'text',
        value: s.name,
        'aria-label': 'Collection name',
        oninput: (e: Event) => {
          s.name = (e.target as HTMLInputElement).value;
          changed();
        },
        onchange: () => app.renderSidebar(),
      }),
      el('div', { class: 'header-actions' }, [
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
    el('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label, badge]) =>
      el('button', { class: `tab${tab === id ? ' active' : ''}`, role: 'tab', type: 'button', 'aria-selected': String(tab === id), onclick: () => go(id) }, [
        label,
        badge ? el('span', { class: 'tab-badge' }, [badge]) : null,
      ]),
    )),
  );

  const panel = el('div', { class: 'tab-panel' });
  root.append(panel);

  if (tab === 'overview') {
    const requests = flatRequests(c.items);
    const description = el('textarea', {
      class: 'description',
      placeholder: 'Describe this API…',
      'aria-label': 'Description',
      oninput: (e: Event) => {
        s.description = (e.target as HTMLTextAreaElement).value;
        changed();
      },
    });
    description.value = s.description;
    panel.append(
      el('div', { class: 'stats' }, [
        stat('Requests', String(countRequests(c.items)), 'send'),
        stat('Folders', String(countFolders(c.items)), 'folder'),
        stat('Variables', String(c.variables.filter((v) => v.enabled).length), 'braces', () => go('variables')),
        stat('Auth', c.auth.type === 'none' ? 'None' : c.auth.type, 'lock', () => go('auth')),
      ]),
      el('label', { class: 'field-label' }, ['Description']),
      description,
      el('h3', { class: 'section' }, ['Requests']),
      requests.length
        ? el('table', { class: 'list' }, [
            el('tbody', {}, requests.map(({ item, path }) =>
              el('tr', { tabindex: '0', onclick: () => app.navigate({ view: 'request', requestId: item.id }), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && app.navigate({ view: 'request', requestId: item.id }) }, [
                el('td', { class: 'method-cell' }, [methodBadge(item.method)]),
                el('td', { class: 'name-cell' }, [item.name, path.length ? el('span', { class: 'muted path' }, [path.join(' › ')]) : null]),
                el('td', { class: 'url-cell' }, [item.url]),
              ]),
            )),
          ])
        : emptyState('send', 'No requests yet', 'Add a request or import an OpenAPI document.', [
            button('New request', () => post({ type: 'itemAction', action: 'newRequest', collectionId }), { icon: 'plus' }),
          ]),
    );
  } else if (tab === 'variables') {
    panel.append(
      el('p', { class: 'hint top' }, [
        'Collection variables are saved in the collection file (shared via git). Environment variables override them; keep credentials in an environment as ',
        el('strong', {}, ['secrets']),
        '. ',
        el('button', { class: 'link-btn', type: 'button', onclick: () => app.navigate({ view: 'variables', environmentId: store.data?.activeEnvironmentId ?? undefined }) }, ['Open environments']),
      ]),
      kvTable(s.variables as Variable[], { noun: 'Variable', changed, rerender, keyPlaceholder: 'baseUrl' }),
    );
  } else {
    panel.append(
      el('p', { class: 'hint top' }, ['Requests and folders set to “Inherit” use this auth.']),
      authEditor(() => s.auth, (a) => (s.auth = a), changed, rerender, false),
    );
  }
}

function stat(label: string, value: string, iconName: Parameters<typeof icon>[0], onclick?: () => void): HTMLElement {
  return el(onclick ? 'button' : 'div', { class: `stat${onclick ? ' clickable' : ''}`, type: onclick ? 'button' : undefined, onclick }, [
    el('span', { class: 'stat-icon' }, [icon(iconName, 16)]),
    el('span', { class: 'stat-value' }, [value]),
    el('span', { class: 'stat-label' }, [label]),
  ]);
}
