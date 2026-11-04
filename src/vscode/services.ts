import * as vscode from 'vscode';
import type { Collection, Environment } from '../shared/model';
import { CollectionStore } from '../core/collectionStore';
import { loadDotenvFile } from '../core/dotenv';
import { FileAccessError } from '../core/fileAccess';
import { EnvironmentStore, type SecretProvider } from '../core/environmentStore';
import type { EngineOptions } from '../core/httpEngine';
import { VariableResolver } from '../core/variables';

const ACTIVE_ENV_KEY = 'httpClient.activeEnvironment';

class VscodeSecrets implements SecretProvider {
  constructor(private readonly storage: vscode.SecretStorage) {}
  get(key: string) {
    return Promise.resolve(this.storage.get(key));
  }
  store(key: string, value: string) {
    return Promise.resolve(this.storage.store(key, value));
  }
  delete(key: string) {
    return Promise.resolve(this.storage.delete(key));
  }
}

/** Owns the stores for the first workspace folder and notifies listeners when data changes. */
export class Services implements vscode.Disposable {
  readonly collections: CollectionStore;
  readonly environments: EnvironmentStore;
  private dotenv: Record<string, string> = {};
  private readonly disposables: vscode.Disposable[] = [];
  private readonly collectionsChanged = new vscode.EventEmitter<void>();
  private readonly environmentsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCollections = this.collectionsChanged.event;
  readonly onDidChangeEnvironments = this.environmentsChanged.event;
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly rootDir: string,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.collections = new CollectionStore(rootDir);
    this.environments = new EnvironmentStore(rootDir, new VscodeSecrets(context.secrets));

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootDir, '{.httpclient/**/*.json,.env}'),
    );
    const onFs = () => this.scheduleReload();
    this.disposables.push(
      watcher,
      watcher.onDidChange(onFs),
      watcher.onDidCreate(onFs),
      watcher.onDidDelete(onFs),
      this.collectionsChanged,
      this.environmentsChanged,
      context.secrets.onDidChange(() => this.scheduleReload()),
    );
  }

  async reload(): Promise<void> {
    await Promise.all([this.collections.load(), this.environments.load(), this.loadDotenv()]);
    this.collectionsChanged.fire();
    this.environmentsChanged.fire();
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reload().catch((err) => vscode.window.showErrorMessage(`HTTP Client: reload failed: ${String(err)}`));
    }, 150);
  }

  private async loadDotenv(): Promise<void> {
    try {
      this.dotenv = await loadDotenvFile(this.rootDir);
    } catch (err) {
      this.dotenv = {};
      if (!(err instanceof FileAccessError)) throw err;
      void vscode.window.showWarningMessage(`HTTP Client: ${err.message} {{$dotenv}} values are disabled.`);
    }
  }

  dotenvKeys(): string[] {
    return Object.keys(this.dotenv).sort();
  }

  get activeEnvironment(): Environment | undefined {
    const id = this.context.workspaceState.get<string>(ACTIVE_ENV_KEY);
    return id ? this.environments.get(id) : undefined;
  }

  async setActiveEnvironment(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_ENV_KEY, id);
    this.environmentsChanged.fire();
  }

  async saveCollection(collection: Collection): Promise<void> {
    await this.collections.save(collection);
    this.collectionsChanged.fire();
  }

  async deleteCollection(id: string): Promise<void> {
    await this.collections.delete(id);
    this.collectionsChanged.fire();
  }

  async saveEnvironment(env: Environment): Promise<void> {
    await this.environments.save(env);
    this.environmentsChanged.fire();
  }

  async deleteEnvironment(id: string): Promise<void> {
    if (this.activeEnvironment?.id === id) await this.context.workspaceState.update(ACTIVE_ENV_KEY, undefined);
    await this.environments.delete(id);
    this.environmentsChanged.fire();
  }

  resolverFor(collection: Collection): VariableResolver {
    return new VariableResolver({
      globals: this.environments.getGlobals().variables,
      collection: collection.variables,
      environment: this.activeEnvironment?.variables,
      dotenv: this.dotenv,
    });
  }

  engineOptions(): EngineOptions {
    const cfg = vscode.workspace.getConfiguration('httpClient');
    const proxy = cfg.get<string>('proxy', '').trim() || vscode.workspace.getConfiguration('http').get<string>('proxy', '').trim();
    return {
      timeoutMs: cfg.get<number>('timeoutMs', 30_000),
      followRedirects: cfg.get<boolean>('followRedirects', true),
      maxRedirects: cfg.get<number>('maxRedirects', 10),
      strictSSL: cfg.get<boolean>('strictSSL', true),
      proxy: proxy || undefined,
      maxResponseBytes: cfg.get<number>('maxResponseBytes', 50 * 1024 * 1024),
      baseDir: this.rootDir,
    };
  }

  dispose(): void {
    clearTimeout(this.reloadTimer);
    for (const d of this.disposables) d.dispose();
  }
}
