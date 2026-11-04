import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { newRequest, type Collection, type FolderItem } from '../shared/model';
import { newId } from '../shared/ids';
import { duplicateItem, findItem, insertItem, moveItem, removeItem } from '../core/collectionOps';
import { GLOBALS_ID } from '../core/environmentStore';
import { executeRequest } from '../core/httpEngine';
import { importOpenApi } from '../core/openapi/importer';
import type { Services } from './services';

const nonEmpty = (v: string) => (v.trim() ? undefined : 'Name is required');

export function countRequests(items: Collection['items']): number {
  return items.reduce((n, it) => n + (it.type === 'request' ? 1 : countRequests(it.items)), 0);
}

/** User-facing operations shared by the workbench GUI and the native tree views. */
export class Actions {
  constructor(private readonly services: Services) {}

  private collection(id: string): Collection {
    const c = this.services.collections.get(id);
    if (!c) throw new Error('Collection not found');
    return c;
  }

  async newCollection(): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({ prompt: 'Collection name', placeHolder: 'My API', validateInput: nonEmpty });
    if (!name) return undefined;
    const id = newId();
    await this.services.saveCollection({
      version: 1,
      id,
      name: name.trim(),
      variables: [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }],
      auth: { type: 'none' },
      items: [],
    });
    return id;
  }

  async newFolder(collectionId: string, parentId: string | null): Promise<string | undefined> {
    const collection = this.collection(collectionId);
    const name = await vscode.window.showInputBox({ prompt: 'Folder name', validateInput: nonEmpty });
    if (!name) return undefined;
    const folder: FolderItem = { type: 'folder', id: newId(), name: name.trim(), items: [] };
    insertItem(collection, parentId, folder);
    await this.services.saveCollection(collection);
    return folder.id;
  }

  /** Creates "New Request" immediately (rename it inline in the editor). */
  async newRequest(collectionId: string, parentId: string | null): Promise<string> {
    const collection = this.collection(collectionId);
    const request = newRequest(newId());
    if (collection.variables.some((v) => v.key === 'baseUrl')) request.url = '{{baseUrl}}/';
    insertItem(collection, parentId, request);
    await this.services.saveCollection(collection);
    return request.id;
  }

  async rename(collectionId: string, itemId?: string): Promise<void> {
    const collection = this.collection(collectionId);
    const item = itemId ? findItem(collection, itemId)?.item : undefined;
    if (itemId && !item) return;
    const current = item?.name ?? collection.name;
    const name = await vscode.window.showInputBox({ prompt: 'New name', value: current, validateInput: nonEmpty });
    if (!name || name === current) return;
    if (item) item.name = name.trim();
    else collection.name = name.trim();
    await this.services.saveCollection(collection);
  }

  async duplicate(collectionId: string, itemId?: string): Promise<string | undefined> {
    const collection = this.collection(collectionId);
    if (!itemId) {
      const copy: Collection = { ...structuredClone(collection), id: newId(), name: `${collection.name} Copy` };
      const reassign = (items: Collection['items']) =>
        items.forEach((it) => {
          it.id = newId();
          if (it.type === 'folder') reassign(it.items);
        });
      reassign(copy.items);
      await this.services.saveCollection(copy);
      return copy.id;
    }
    const copy = duplicateItem(collection, itemId);
    if (!copy) return undefined;
    await this.services.saveCollection(collection);
    return copy.id;
  }

  async remove(collectionId: string, itemId?: string): Promise<boolean> {
    const collection = this.collection(collectionId);
    const item = itemId ? findItem(collection, itemId)?.item : undefined;
    if (itemId && !item) return false;
    const what = item ? `${item.type} "${item.name}"` : `collection "${collection.name}" and all its requests`;
    const answer = await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true }, 'Delete');
    if (answer !== 'Delete') return false;
    if (!itemId) {
      await this.services.deleteCollection(collectionId);
    } else {
      removeItem(collection, itemId);
      await this.services.saveCollection(collection);
    }
    return true;
  }

  /** Moves an item within or across collections. `index` inserts before that position in the target parent. */
  async move(collectionId: string, itemId: string, targetCollectionId: string, targetParentId: string | null, index?: number): Promise<boolean> {
    const source = this.collection(collectionId);
    const target = this.collection(targetCollectionId);
    if (itemId === targetParentId) return false;
    if (source === target) {
      if (!moveItem(target, itemId, targetParentId, index)) return false;
      await this.services.saveCollection(target);
      return true;
    }
    if (targetParentId !== null && findItem(target, targetParentId)?.item.type !== 'folder') return false;
    const item = removeItem(source, itemId);
    if (!item) return false;
    insertItem(target, targetParentId, item, index);
    await this.services.saveCollection(source);
    await this.services.saveCollection(target);
    return true;
  }

  async importOpenApi(): Promise<string | undefined> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(file) From file…', id: 'file' },
        { label: '$(globe) From URL…', id: 'url' },
      ],
      { placeHolder: 'Import an OpenAPI 3.x or Swagger 2.0 document' },
    );
    if (!choice) return undefined;

    let text: string;
    let location: string;
    let isUrl = false;
    if (choice.id === 'file') {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'OpenAPI / Swagger': ['json', 'yaml', 'yml'] } });
      if (!picked?.[0]) return undefined;
      location = picked[0].fsPath;
      text = await readFile(location, 'utf8');
    } else {
      const url = await vscode.window.showInputBox({
        prompt: 'URL of the OpenAPI / Swagger document',
        placeHolder: 'https://petstore3.swagger.io/api/v3/openapi.json',
        validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
      });
      if (!url) return undefined;
      location = url.trim();
      isUrl = true;
      const res = await executeRequest(
        { method: 'GET', url: location, headers: [['Accept', 'application/json, application/yaml, text/yaml, */*']], body: { kind: 'none' } },
        this.services.engineOptions(),
      );
      if (res.status < 200 || res.status >= 300) throw new Error(`Download failed: HTTP ${res.status}`);
      text = res.bodyEncoding === 'base64' ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
    }

    const collection = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Importing OpenAPI document…' },
      () => importOpenApi({ text, location, isUrl }),
    );
    await this.services.saveCollection(collection);
    void vscode.window.showInformationMessage(
      `Imported "${collection.name}" with ${countRequests(collection.items)} requests. Put credentials in an environment as secrets.`,
    );
    return collection.id;
  }

  async newEnvironment(): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({ prompt: 'Environment name', placeHolder: 'Development', validateInput: nonEmpty });
    if (!name) return undefined;
    const env = { version: 1 as const, id: newId(), name: name.trim(), variables: [] };
    await this.services.saveEnvironment(env);
    if (!this.services.activeEnvironment) await this.services.setActiveEnvironment(env.id);
    return env.id;
  }

  async renameEnvironment(id: string): Promise<void> {
    const env = this.services.environments.get(id);
    if (!env || id === GLOBALS_ID) return;
    const name = await vscode.window.showInputBox({ prompt: 'Environment name', value: env.name, validateInput: nonEmpty });
    if (!name || name === env.name) return;
    await this.services.saveEnvironment({ ...structuredClone(env), name: name.trim() });
  }

  async duplicateEnvironment(id: string): Promise<string | undefined> {
    const env = this.services.environments.get(id);
    if (!env || id === GLOBALS_ID) return undefined;
    const copy = { ...structuredClone(env), id: newId(), name: `${env.name} Copy` };
    await this.services.saveEnvironment(copy);
    return copy.id;
  }

  async deleteEnvironment(id: string): Promise<boolean> {
    const env = this.services.environments.get(id);
    if (!env || id === GLOBALS_ID) return false;
    const answer = await vscode.window.showWarningMessage(`Delete environment "${env.name}"?`, { modal: true }, 'Delete');
    if (answer !== 'Delete') return false;
    await this.services.deleteEnvironment(id);
    return true;
  }
}
