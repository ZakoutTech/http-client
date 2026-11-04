import type { Collection, CollectionItem } from '../shared/model';
import { methodBadge, showMenu, type MenuItem } from './components';
import { el, icon, iconButton } from './dom';
import { app, countRequests, persist, post, store } from './store';

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
      (e.currentTarget as HTMLElement).classList.add('drop-target');
    },
    ondragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-target'),
    ondrop: (e: DragEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.remove('drop-target');
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
    const indent = { style: undefined, 'data-depth': String(depth) };
    if (item.type === 'folder') {
      const open = q !== '' || store.expanded.has(item.id);
      rows.push(
        el('div', {
          ...indent,
          class: 'row folder-row',
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
          el('span', { class: 'label' }, [item.name]),
          el('span', { class: 'row-actions' }, [
            iconButton('plus', 'New request in folder', () => post({ type: 'itemAction', action: 'newRequest', collectionId: collection.id, itemId: item.id })),
            iconButton('more', 'More actions', (e) => showMenu(e, itemMenu(collection, item))),
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
        ...indent,
        class: `row request-row${selected ? ' selected' : ''}`,
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
        el('span', { class: 'label' }, [item.name]),
        sending ? el('span', { class: 'spinner small' }) : null,
        el('span', { class: 'row-actions' }, [iconButton('more', 'More actions', (e) => showMenu(e, itemMenu(collection, item)))]),
      ]),
    );
  });
  return rows;
}

export function renderSidebar(container: HTMLElement): void {
  const data = store.data;
  const q = store.search.trim().toLowerCase();
  let search = container.querySelector<HTMLInputElement>('input.search');
  if (!search) {
    search = el('input', {
      class: 'search',
      type: 'search',
      placeholder: 'Search requests',
      'aria-label': 'Search requests',
      oninput: (e: Event) => {
        store.search = (e.target as HTMLInputElement).value;
        app.renderSidebar();
      },
    });
    container.replaceChildren(
      el('div', { class: 'sidebar-head' }, [
        el('div', { class: 'search-box' }, [icon('search', 14), search]),
        el('div', { class: 'sidebar-toolbar' }, [
          el('span', { class: 'section-title' }, ['Collections']),
          iconButton('plus', 'New collection', () => post({ type: 'action', action: 'newCollection' })),
          iconButton('download', 'Import OpenAPI / Swagger', () => post({ type: 'action', action: 'importOpenApi' })),
        ]),
      ]),
      el('div', { class: 'tree', role: 'tree', 'aria-label': 'Collections' }),
    );
  }
  const tree = container.querySelector('.tree') as HTMLElement;
  tree.replaceChildren();
  if (!data) return;
  if (!data.collections.length) {
    tree.append(el('p', { class: 'muted pad' }, ['No collections yet. Create one or import an OpenAPI document.']));
    return;
  }
  for (const c of data.collections) {
    if (q && !c.items.some((it) => matches(it, q)) && !c.name.toLowerCase().includes(q)) continue;
    const open = q !== '' || store.expanded.has(c.id);
    const selected = store.route.view === 'collection' && store.route.collectionId === c.id;
    tree.append(
      el('div', {
        class: `row collection-row${selected ? ' selected' : ''}`,
        role: 'treeitem',
        'aria-expanded': String(open),
        tabindex: '0',
        'data-depth': '0',
        ...dropHandlers(c.id, undefined, null),
        onclick: () => toggle(c.id),
        oncontextmenu: (e: MouseEvent) => showMenu(e, itemMenu(c)),
      }, [
        icon(open ? 'chevronDown' : 'chevronRight', 14),
        icon('collection', 15),
        el('span', { class: 'label' }, [c.name]),
        el('span', { class: 'count-badge' }, [String(countRequests(c.items))]),
        el('span', { class: 'row-actions' }, [
          iconButton('plus', 'New request', () => post({ type: 'itemAction', action: 'newRequest', collectionId: c.id })),
          iconButton('gear', 'Collection settings & variables', () => app.navigate({ view: 'collection', collectionId: c.id })),
          iconButton('more', 'More actions', (e) => showMenu(e, itemMenu(c))),
        ]),
      ]),
    );
    if (open) {
      const rows = renderItems(c, c.items, null, 1, q);
      tree.append(...(rows.length ? rows : [el('p', { class: 'muted row-empty' }, ['Empty — add a request with +'])]));
    }
  }
}
