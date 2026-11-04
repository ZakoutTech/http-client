import type { Auth, Collection, CollectionItem, FolderItem } from '../shared/model';
import { newId } from '../shared/ids';

type Container = Collection | FolderItem;

export interface Located {
  item: CollectionItem;
  parent: Container;
  index: number;
  /** Folders from the collection root down to (excluding) the item. */
  ancestors: FolderItem[];
}

export function findItem(collection: Collection, id: string): Located | undefined {
  const visit = (container: Container, ancestors: FolderItem[]): Located | undefined => {
    for (let index = 0; index < container.items.length; index++) {
      const item = container.items[index];
      if (item.id === id) return { item, parent: container, index, ancestors };
      if (item.type === 'folder') {
        const found = visit(item, [...ancestors, item]);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(collection, []);
}

function containerFor(collection: Collection, parentId: string | null): Container {
  if (parentId === null || parentId === collection.id) return collection;
  const found = findItem(collection, parentId);
  if (!found || found.item.type !== 'folder') throw new Error(`Folder ${parentId} not found`);
  return found.item;
}

export function insertItem(
  collection: Collection,
  parentId: string | null,
  item: CollectionItem,
  index?: number,
): void {
  const container = containerFor(collection, parentId);
  const at = index === undefined ? container.items.length : Math.max(0, Math.min(index, container.items.length));
  container.items.splice(at, 0, item);
}

export function removeItem(collection: Collection, id: string): CollectionItem | undefined {
  const found = findItem(collection, id);
  if (!found) return undefined;
  found.parent.items.splice(found.index, 1);
  return found.item;
}

function containsId(item: CollectionItem, id: string): boolean {
  if (item.id === id) return true;
  return item.type === 'folder' && item.items.some((child) => containsId(child, id));
}

/** Moves an item; refuses to move a folder into itself or one of its descendants. */
export function moveItem(collection: Collection, id: string, targetParentId: string | null, index?: number): boolean {
  const found = findItem(collection, id);
  if (!found) return false;
  if (targetParentId !== null && targetParentId !== collection.id && containsId(found.item, targetParentId)) {
    return false;
  }
  const target = containerFor(collection, targetParentId);
  let at = index;
  if (at !== undefined && target === found.parent && found.index < at) at -= 1;
  found.parent.items.splice(found.index, 1);
  insertItem(collection, target === collection ? null : (target as FolderItem).id, found.item, at);
  return true;
}

export function cloneWithNewIds<T extends CollectionItem>(item: T): T {
  const copy = structuredClone(item);
  const reassign = (it: CollectionItem): void => {
    it.id = newId();
    if (it.type === 'folder') it.items.forEach(reassign);
  };
  reassign(copy);
  return copy;
}

export function duplicateItem(collection: Collection, id: string): CollectionItem | undefined {
  const found = findItem(collection, id);
  if (!found) return undefined;
  const copy = cloneWithNewIds(found.item);
  copy.name = `${found.item.name} Copy`;
  found.parent.items.splice(found.index + 1, 0, copy);
  return copy;
}

/** Resolves `inherit` by walking up folders to the collection. */
export function effectiveAuth(collection: Collection, id: string): Auth {
  const found = findItem(collection, id);
  if (!found) return { type: 'none' };
  const own = found.item.auth;
  if (own && own.type !== 'inherit') return own;
  for (let i = found.ancestors.length - 1; i >= 0; i--) {
    const auth = found.ancestors[i].auth;
    if (auth && auth.type !== 'inherit') return auth;
  }
  return collection.auth.type === 'inherit' ? { type: 'none' } : collection.auth;
}
