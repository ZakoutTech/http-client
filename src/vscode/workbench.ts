import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { Collection, RequestItem, ResponseData } from '../shared/model';
import { isWebviewToHost, type HostToWebview, type NavTarget, type WebviewToHost, type WorkbenchState } from '../shared/messages';
import { effectiveAuth, findItem } from '../core/collectionOps';
import { GLOBALS_ID } from '../core/environmentStore';
import { applyEnvironmentUpdate, toEnvironmentView } from '../core/environmentView';
import { filesOutsideRoot } from '../core/fileAccess';
import { executeRequest, RequestCancelledError } from '../core/httpEngine';
import { toRequestPath } from '../core/paths';
import { buildRequest, toCurl, type ResolvedRequest } from '../core/requestBuilder';
import type { Actions } from './actions';
import type { Services } from './services';

function locate(services: Services, requestId: string): { collection: Collection; request: RequestItem } | undefined {
  for (const collection of services.collections.list()) {
    const found = findItem(collection, requestId);
    if (found?.item.type === 'request') return { collection, request: found.item };
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}

/** The single "HTTP Client" webview: collections sidebar, request editor, collection settings and variables manager. */
export class Workbench implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queue: HostToWebview[] = [];
  private stateTimer: NodeJS.Timeout | undefined;
  private readonly aborts = new Map<string, AbortController>();
  private readonly responses = new Map<string, ResponseData>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly services: Services,
    private readonly actions: Actions,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      services.onDidChangeCollections(() => this.scheduleState()),
      services.onDidChangeEnvironments(() => this.scheduleState()),
    );
  }

  show(target?: NavTarget): void {
    if (!this.panel) this.create();
    this.panel?.reveal(undefined, false);
    if (target) this.post({ type: 'navigate', target });
  }

  private create(): void {
    const panel = vscode.window.createWebviewPanel('httpClient.workbench', 'HTTP Client', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'images', 'icon.png');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!isWebviewToHost(msg)) return; // ignore anything that does not match the protocol
      this.handle(msg).catch((err) => this.post({ type: 'error', message: errorMessage(err) }));
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      this.queue = [];
      for (const a of this.aborts.values()) a.abort();
      this.aborts.clear();
    });
    this.panel = panel;
  }

  private post(msg: HostToWebview): void {
    if (!this.panel) return;
    if (!this.ready) {
      this.queue.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private scheduleState(): void {
    if (!this.panel || !this.ready) return;
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => this.post({ type: 'state', state: this.snapshot() }), 30);
  }

  snapshot(): WorkbenchState {
    const env = this.services.environments;
    return {
      collections: this.services.collections.list(),
      globals: toEnvironmentView(env.getGlobals()),
      environments: env.list().map(toEnvironmentView),
      activeEnvironmentId: this.services.activeEnvironment?.id ?? null,
      dotenvKeys: this.services.dotenvKeys(),
    };
  }

  private async handle(msg: WebviewToHost): Promise<void> {
    const a = this.actions;
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        void this.panel?.webview.postMessage({ type: 'state', state: this.snapshot() } satisfies HostToWebview);
        const queued = this.queue;
        this.queue = [];
        queued.forEach((m) => this.post(m));
        return;
      }
      case 'updateRequest': {
        const loc = locate(this.services, msg.request.id);
        const found = loc && findItem(loc.collection, msg.request.id);
        if (!loc || !found) return;
        found.parent.items[found.index] = { ...msg.request, type: 'request' };
        await this.services.saveCollection(loc.collection);
        return;
      }
      case 'updateCollection': {
        const c = this.services.collections.get(msg.collectionId);
        if (!c) return;
        const { name, description, variables, auth } = msg.patch;
        if (name !== undefined && name.trim()) c.name = name.trim();
        if (description !== undefined) c.description = description || undefined;
        if (variables !== undefined) c.variables = variables.map(({ key, value, enabled }) => ({ key, value, enabled }));
        if (auth !== undefined) c.auth = auth;
        await this.services.saveCollection(c);
        return;
      }
      case 'saveEnvironment': {
        const existing = this.services.environments.get(msg.environment.id);
        if (!existing) return;
        const merged = applyEnvironmentUpdate(existing, msg.environment, msg.secretUpdates);
        if (existing.id === GLOBALS_ID) merged.name = existing.name;
        await this.services.saveEnvironment(merged);
        return;
      }
      case 'setActiveEnvironment':
        if (msg.environmentId === null || this.services.environments.get(msg.environmentId)) {
          await this.services.setActiveEnvironment(msg.environmentId ?? undefined);
        }
        return;
      case 'action':
        if (msg.action === 'newCollection') {
          const id = await a.newCollection();
          if (id) this.post({ type: 'navigate', target: { view: 'collection', collectionId: id } });
        } else if (msg.action === 'importOpenApi') {
          const id = await a.importOpenApi();
          if (id) this.post({ type: 'navigate', target: { view: 'collection', collectionId: id } });
        } else {
          const id = await a.newEnvironment();
          if (id) this.post({ type: 'navigate', target: { view: 'variables', environmentId: id } });
        }
        return;
      case 'itemAction':
        await this.itemAction(msg.action, msg.collectionId, msg.itemId);
        return;
      case 'envAction':
        if (msg.action === 'rename') await a.renameEnvironment(msg.environmentId);
        else if (msg.action === 'delete') {
          if (await a.deleteEnvironment(msg.environmentId)) this.post({ type: 'navigate', target: { view: 'variables' } });
        } else {
          const id = await a.duplicateEnvironment(msg.environmentId);
          if (id) this.post({ type: 'navigate', target: { view: 'variables', environmentId: id } });
        }
        return;
      case 'move':
        await a.move(msg.collectionId, msg.itemId, msg.targetCollectionId, msg.targetParentId, msg.index);
        return;
      case 'send':
        await this.send(msg.request);
        return;
      case 'cancel':
        this.aborts.get(msg.requestId)?.abort();
        return;
      case 'saveResponse':
        await this.saveResponse(msg.requestId);
        return;
      case 'copyAsCurl': {
        const loc = locate(this.services, msg.request.id);
        if (!loc) return;
        const req = buildRequest(msg.request, effectiveAuth(loc.collection, msg.request.id), this.services.resolverFor(loc.collection));
        await vscode.env.clipboard.writeText(toCurl(req));
        void vscode.window.showInformationMessage('cURL command copied to clipboard.');
        return;
      }
      case 'pickFiles': {
        // Always answer, even on failure, so the webview's pending pick never hangs.
        let paths: string[] = [];
        try {
          const root = this.services.rootDir;
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: msg.many,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: msg.many ? 'Attach files' : 'Attach file',
            defaultUri: vscode.Uri.file(root),
          });
          paths = (picked ?? []).map((uri) => toRequestPath(uri.fsPath, root));
        } finally {
          this.post({ type: 'filesPicked', pickId: msg.pickId, paths });
        }
        return;
      }
    }
  }

  private async itemAction(action: string, collectionId: string, itemId?: string): Promise<void> {
    const a = this.actions;
    switch (action) {
      case 'newRequest': {
        const id = await a.newRequest(collectionId, itemId ?? null);
        this.post({ type: 'navigate', target: { view: 'request', requestId: id } });
        return;
      }
      case 'newFolder':
        await a.newFolder(collectionId, itemId ?? null);
        return;
      case 'rename':
        await a.rename(collectionId, itemId);
        return;
      case 'duplicate': {
        const id = await a.duplicate(collectionId, itemId);
        if (id && !itemId) this.post({ type: 'navigate', target: { view: 'collection', collectionId: id } });
        return;
      }
      case 'delete':
        if ((await a.remove(collectionId, itemId)) && !itemId) this.post({ type: 'navigate', target: { view: 'welcome' } });
        return;
    }
  }

  private async send(request: RequestItem): Promise<void> {
    const loc = locate(this.services, request.id);
    if (!loc) throw new Error('Request no longer exists');
    const requestId = request.id;
    const resolver = this.services.resolverFor(loc.collection);
    let unresolved: string[] = [];
    this.aborts.get(requestId)?.abort();
    const abort = new AbortController();
    this.aborts.set(requestId, abort);
    this.post({ type: 'sending', requestId });
    try {
      const resolved = buildRequest(request, effectiveAuth(loc.collection, requestId), resolver);
      unresolved = [...resolver.unresolved];
      const allowFilesOutside = await this.confirmOutsideFiles(resolved.body, resolved.url);
      const response = await executeRequest(resolved, { ...this.services.engineOptions(), allowFilesOutside }, abort.signal);
      this.responses.set(requestId, response);
      this.post({ type: 'response', requestId, response, unresolved });
    } catch (err) {
      this.post({
        type: 'error',
        requestId,
        message: err instanceof RequestCancelledError ? 'Request cancelled' : errorMessage(err),
        unresolved: unresolved.length ? unresolved : [...resolver.unresolved],
      });
    } finally {
      if (this.aborts.get(requestId) === abort) this.aborts.delete(requestId);
    }
  }

  /**
   * Files outside the workspace are never uploaded silently (a shared collection could point at
   * ~/.ssh or similar): the user must approve the exact files and destination for this send.
   */
  private async confirmOutsideFiles(body: ResolvedRequest['body'], url: string): Promise<Set<string>> {
    const outside = await filesOutsideRoot(body, this.services.rootDir);
    if (!outside.length) return new Set();
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep the raw URL
    }
    const list = outside.map((f) => `• ${f.real}`).join('\n');
    const choice = await vscode.window.showWarningMessage(
      `This request uploads ${outside.length === 1 ? 'a file' : `${outside.length} files`} from outside the workspace to ${host}.`,
      { modal: true, detail: `${list}\n\nOnly continue if you trust this request and its destination.` },
      'Upload anyway',
    );
    if (choice !== 'Upload anyway') throw new Error('Upload cancelled: files outside the workspace were not approved.');
    return new Set(outside.map((f) => f.real));
  }

  private async saveResponse(requestId: string): Promise<void> {
    const res = this.responses.get(requestId);
    if (!res) return;
    const ext = /json/.test(res.contentType) ? 'json' : /xml/.test(res.contentType) ? 'xml' : /html/.test(res.contentType) ? 'html' : 'txt';
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(vscode.Uri.file(this.services.rootDir), `response.${res.bodyEncoding === 'base64' ? 'bin' : ext}`),
    });
    if (!target) return;
    await writeFile(target.fsPath, res.bodyEncoding === 'base64' ? Buffer.from(res.body, 'base64') : Buffer.from(res.body, 'utf8'));
  }

  private html(webview: vscode.Webview): string {
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>HTTP Client</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    clearTimeout(this.stateTimer);
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
