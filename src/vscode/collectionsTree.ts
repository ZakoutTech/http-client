import * as vscode from 'vscode';
import type { Collection, CollectionItem } from '../shared/model';
import { findItem, insertItem, moveItem, removeItem } from '../core/collectionOps';
import type { Services } from './services';

export interface CollectionNode {
  kind: 'collection' | 'folder' | 'request';
  collectionId: string;
  /** Item id; for collections equals collectionId. */
  id: string;
}

const MIME = 'application/vnd.code.tree.httpclient.collections';

const METHOD_COLORS: Record<string, string> = {
  GET: 'charts.green',
  POST: 'charts.yellow',
  PUT: 'charts.blue',
  PATCH: 'charts.purple',
  DELETE: 'charts.red',
};

export class CollectionsTree
  implements vscode.TreeDataProvider<CollectionNode>, vscode.TreeDragAndDropController<CollectionNode>
{
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];
  private readonly changed = new vscode.EventEmitter<CollectionNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly services: Services) {
    services.onDidChangeCollections(() => this.changed.fire(undefined));
  }

  resolve(node: CollectionNode): { collection: Collection; item?: CollectionItem } | undefined {
    const collection = this.services.collections.get(node.collectionId);
    if (!collection) return undefined;
    if (node.kind === 'collection') return { collection };
    const found = findItem(collection, node.id);
    return found ? { collection, item: found.item } : undefined;
  }

  getTreeItem(node: CollectionNode): vscode.TreeItem {
    const resolved = this.resolve(node);
    if (!resolved) return new vscode.TreeItem('(missing)');
    if (node.kind === 'collection') {
      const ti = new vscode.TreeItem(resolved.collection.name, vscode.TreeItemCollapsibleState.Collapsed);
      ti.iconPath = new vscode.ThemeIcon('library');
      ti.contextValue = 'collection';
      ti.id = `c:${node.collectionId}`;
      ti.tooltip = this.services.collections.fileOf(node.collectionId);
      return ti;
    }
    const item = resolved.item as CollectionItem;
    if (item.type === 'folder') {
      const ti = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.Collapsed);
      ti.iconPath = vscode.ThemeIcon.Folder;
      ti.contextValue = 'folder';
      ti.id = `f:${node.collectionId}:${item.id}`;
      return ti;
    }
    const ti = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None);
    ti.description = item.method;
    ti.tooltip = `${item.method} ${item.url}`;
    ti.iconPath = new vscode.ThemeIcon('symbol-event', new vscode.ThemeColor(METHOD_COLORS[item.method] ?? 'foreground'));
    ti.contextValue = 'request';
    ti.id = `r:${node.collectionId}:${item.id}`;
    ti.command = { command: 'httpClient.openRequest', title: 'Open Request', arguments: [node] };
    return ti;
  }

  getChildren(node?: CollectionNode): CollectionNode[] {
    if (!node) {
      return this.services.collections.list().map((c) => ({ kind: 'collection', collectionId: c.id, id: c.id }));
    }
    const resolved = this.resolve(node);
    if (!resolved) return [];
    const items = node.kind === 'collection' ? resolved.collection.items : resolved.item?.type === 'folder' ? resolved.item.items : [];
    return items.map((it) => ({ kind: it.type, collectionId: node.collectionId, id: it.id }));
  }

  getParent(node: CollectionNode): CollectionNode | undefined {
    if (node.kind === 'collection') return undefined;
    const collection = this.services.collections.get(node.collectionId);
    const found = collection && findItem(collection, node.id);
    if (!found) return undefined;
    const parent = found.ancestors.at(-1);
    return parent
      ? { kind: 'folder', collectionId: node.collectionId, id: parent.id }
      : { kind: 'collection', collectionId: node.collectionId, id: node.collectionId };
  }

  handleDrag(source: readonly CollectionNode[], data: vscode.DataTransfer): void {
    const movable = source.filter((n) => n.kind !== 'collection');
    if (movable.length) data.set(MIME, new vscode.DataTransferItem(movable));
  }

  async handleDrop(target: CollectionNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const transfer = data.get(MIME);
    if (!transfer || !target) return;
    const nodes = transfer.value as CollectionNode[];
    const targetCollection = this.services.collections.get(target.collectionId);
    if (!targetCollection) return;

    // Dropping on a request inserts before it in its parent; on a folder/collection appends inside.
    let parentId: string | null;
    let index: number | undefined;
    if (target.kind === 'request') {
      const found = findItem(targetCollection, target.id);
      if (!found) return;
      parentId = found.parent === targetCollection ? null : found.parent.id;
      index = found.index;
    } else {
      parentId = target.kind === 'collection' ? null : target.id;
    }

    const touched = new Set<Collection>([targetCollection]);
    for (const node of nodes) {
      if (node.id === target.id) continue;
      if (node.collectionId === target.collectionId) {
        if (!moveItem(targetCollection, node.id, parentId, index)) continue;
      } else {
        const source = this.services.collections.get(node.collectionId);
        const item = source && removeItem(source, node.id);
        if (!source || !item) continue;
        insertItem(targetCollection, parentId, item, index);
        touched.add(source);
      }
      if (index !== undefined) index++;
    }
    for (const c of touched) await this.services.saveCollection(c);
  }
}
