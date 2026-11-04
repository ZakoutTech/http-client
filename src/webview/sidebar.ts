import type { Collection, CollectionItem } from '../shared/model';
import { methodBadge, showMenu, type MenuItem } from './components';
import { el, icon, iconButton } from './dom';
import { app, countRequests, persist, post, store } from './store';
import { BADGE, cx, ICON_BTN_SMALL, SECTION_TITLE, SPINNER_SMALL } from './ui';

/** Indent per tree depth (static strings so Tailwind can see them). */
const INDENT = ['pl-2', 'pl-6', 'pl-10', 'pl-14', 'pl-[72px]', 'pl-[88px]', 'pl-[104px]'];

const rowClass = (depth: number, selected = false, extra = ''): string =>
  cx(
    'group flex h-7 cursor-pointer select-none items-center gap-1.5 border-l-2 pr-1.5 data-drop:outline data-drop:outline-dashed data-drop:outline-accent data-drop:-outline-offset-2',
    INDENT[Math.min(depth, INDENT.length - 1)],
    selected ? 'border-accent bg-selected text-selected-fg' : 'border-transparent hover:bg-hover',
    extra,
  );

const LABEL = 'flex-1 truncate';
const rowActions = (selected: boolean): string => cx('gap-0 group-hover:inline-flex group-focus-within:inline-flex', selected ? 'inline-flex' : 'hidden');
const smallIcon = (name: Parameters<typeof iconButton>[0], label: string, onclick: (e: MouseEvent) => void) => iconButton(name, label, onclick, ICON_BTN_SMALL);

interface DragInfo {
  collectionId: string;
  itemId: string;
}

let drag: DragInfo | undefined;

function matches(item: CollectionItem, q: string): boolean {
  if (item.type === 'folder') return item.name.toLowerCase().includes(q) || item.items.some((c) => matches(c, q));
  return `${item.method} ${item.name} ${item.url}`.toLowerCase().includes(q);
}

function toggle(id: string): void {
  if (store.expanded.has(id)) store.expanded.delete(id);
  else store.expanded.add(id);
  persist();
  app.renderSidebar();
}

function itemMenu(collection: Collection, item?: CollectionItem): MenuItem[] {
  const base = { collectionId: collection.id, itemId: item?.id };
  const items: MenuItem[] = [];
  if (!item || item.type === 'folder') {
    items.push(
      { label: 'New request', icon: 'plus', run: () => post({ type: 'itemAction', action: 'newRequest', ...base }) },
      { label: 'New folder', icon: 'folderPlus', run: () => post({ type: 'itemAction', action: 'newFolder', ...base }) },
    );
  }
  if (!item) items.push({ label: 'Settings & variables', icon: 'gear', run: () => app.navigate({ view: 'collection', collectionId: collection.id }) });
  items.push(
    { label: 'Rename…', icon: 'edit', run: () => post({ type: 'itemAction', action: 'rename', ...base }) },
    { label: 'Duplicate', icon: 'copy', run: () => post({ type: 'itemAction', action: 'duplicate', ...base }) },
    { label: 'Delete', icon: 'trash', danger: true, run: () => post({ type: 'itemAction', action: 'delete', ...base }) },
  );
  return items;
}

function dropHandlers(collectionId: string, target: CollectionItem | undefined, parentId: string | null, index?: number) {
  return {
    ondragover: (e: DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).dataset.drop = '';
    },
    ondragleave: (e: DragEvent) => delete (e.currentTarget as HTMLElement).dataset.drop,
    ondrop: (e: DragEvent) => {
      e.preventDefault();
      delete (e.currentTarget as HTMLElement).dataset.drop;
      if (!drag || drag.itemId === target?.id) return;
      post({ type: 'move', collectionId: drag.collectionId, itemId: drag.itemId, targetCollectionId: collectionId, targetParentId: parentId, index });
      if (parentId) store.expanded.add(parentId);
      drag = undefined;
    },
  };
}

function renderItems(collection: Collection, items: CollectionItem[], parentId: string | null, depth: number, q: string): HTMLElement[] {
  const rows: HTMLElement[] = [];
  items.forEach((item, index) => {
    if (q && !matches(item, q)) return;
    if (item.type === 'folder') {
      const open = q !== '' || store.expanded.has(item.id);
      rows.push(
        el('div', {
          class: rowClass(depth),
          role: 'treeitem',
          'aria-expanded': String(open),
          tabindex: '0',
          draggable: 'true',
          ondragstart: () => (drag = { collectionId: collection.id, itemId: item.id }),
          ...dropHandlers(collection.id, item, item.id),
          onclick: () => toggle(item.id),
          oncontextmenu: (e: MouseEvent) => showMenu(e, itemMenu(collection, item)),
        }, [
          icon(open ? 'chevronDown' : 'chevronRight', 14),
          icon('folder', 15),
          el('span', { class: LABEL }, [item.name]),
          el('span', { class: rowActions(false) }, [
            smallIcon('plus', 'New request in folder', () => post({ type: 'itemAction', action: 'newRequest', collectionId: collection.id, itemId: item.id })),
            smallIcon('more', 'More actions', (e) => showMenu(e, itemMenu(collection, item))),
          ]),
        ]),
      );
      if (open) rows.push(...renderItems(collection, item.items, item.id, depth + 1, q));
      return;
    }
    const selected = store.route.view === 'request' && store.route.requestId === item.id;
    const sending = store.responses.get(item.id)?.sending;
    rows.push(
      el('div', {
        class: rowClass(depth, selected, selected ? '[&>span:first-child]:brightness-130' : ''),
        role: 'treeitem',
        'aria-selected': String(selected),
        tabindex: '0',
        title: item.url,
        draggable: 'true',
        ondragstart: () => (drag = { collectionId: collection.id, itemId: item.id }),
        ...dropHandlers(collection.id, item, parentId, index),
        onclick: () => app.navigate({ view: 'request', requestId: item.id }),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') app.navigate({ view: 'request', requestId: item.id });
        },
        oncontextmenu: (e: MouseEvent) => showMenu(e, itemMenu(collection, item)),
      }, [
        methodBadge(item.method),
        el('span', { class: LABEL }, [item.name]),
        sending ? el('span', { class: SPINNER_SMALL }) : null,
        el('span', { class: rowActions(selected) }, [smallIcon('more', 'More actions', (e) => showMenu(e, itemMenu(collection, item)))]),
      ]),
    );
  });
  return rows;
}

export function renderSidebar(container: HTMLElement): void {
  const data = store.data;
  const q = store.search.trim().toLowerCase();
  let search = container.querySelector<HTMLInputElement>('[data-role=search]');
  if (!search) {
    search = el('input', {
      class: 'flex-1 border-none bg-transparent px-0 py-[5px] outline-none focus:outline-none',
      'data-role': 'search',
      type: 'search',
      placeholder: 'Search requests',
      'aria-label': 'Search requests',
      oninput: (e: Event) => {
        store.search = (e.target as HTMLInputElement).value;
        app.renderSidebar();
      },
    });
    container.replaceChildren(
      el('div', { class: 'flex flex-col gap-2 px-2.5 pt-2.5 pb-1' }, [
        el('div', { class: 'flex items-center gap-1.5 rounded border border-input-border bg-input px-2 text-muted' }, [icon('search', 14), search]),
        el('div', { class: 'flex items-center gap-0.5' }, [
          el('span', { class: SECTION_TITLE }, ['Collections']),
          iconButton('plus', 'New collection', () => post({ type: 'action', action: 'newCollection' })),
          iconButton('download', 'Import OpenAPI / Swagger', () => post({ type: 'action', action: 'importOpenApi' })),
        ]),
      ]),
      el('div', { class: 'flex-auto overflow-auto pt-0.5 pb-3', 'data-role': 'tree', role: 'tree', 'aria-label': 'Collections' }),
    );
  }
  const tree = container.querySelector('[data-role=tree]') as HTMLElement;
  tree.replaceChildren();
  if (!data) return;
  if (!data.collections.length) {
    tree.append(el('p', { class: 'px-3 py-2 text-muted' }, ['No collections yet. Create one or import an OpenAPI document.']));
    return;
  }
  for (const c of data.collections) {
    if (q && !c.items.some((it) => matches(it, q)) && !c.name.toLowerCase().includes(q)) continue;
    const open = q !== '' || store.expanded.has(c.id);
    const selected = store.route.view === 'collection' && store.route.collectionId === c.id;
    tree.append(
      el('div', {
        class: rowClass(0, selected, 'font-semibold'),
        role: 'treeitem',
        'aria-expanded': String(open),
        tabindex: '0',
        ...dropHandlers(c.id, undefined, null),
        onclick: () => toggle(c.id),
        oncontextmenu: (e: MouseEvent) => showMenu(e, itemMenu(c)),
      }, [
        icon(open ? 'chevronDown' : 'chevronRight', 14),
        icon('collection', 15),
        el('span', { class: LABEL }, [c.name]),
        el('span', { class: cx(BADGE, 'font-normal group-hover:hidden') }, [String(countRequests(c.items))]),
        el('span', { class: rowActions(selected) }, [
          smallIcon('plus', 'New request', () => post({ type: 'itemAction', action: 'newRequest', collectionId: c.id })),
          smallIcon('gear', 'Collection settings & variables', () => app.navigate({ view: 'collection', collectionId: c.id })),
          smallIcon('more', 'More actions', (e) => showMenu(e, itemMenu(c))),
        ]),
      ]),
    );
    if (open) {
      const rows = renderItems(c, c.items, null, 1, q);
      tree.append(...(rows.length ? rows : [el('p', { class: 'mt-0.5 mb-1.5 ml-10 text-[0.9em] text-muted' }, ['Empty — add a request with +'])]));
    }
  }
}
