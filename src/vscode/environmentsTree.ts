import * as vscode from 'vscode';
import { GLOBALS_ID } from '../core/environmentStore';
import type { Services } from './services';

export interface EnvNode {
  kind: 'globals' | 'environment' | 'variable';
  envId: string;
  key?: string;
}

export class EnvironmentsTree implements vscode.TreeDataProvider<EnvNode> {
  private readonly changed = new vscode.EventEmitter<EnvNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly services: Services) {
    services.onDidChangeEnvironments(() => this.changed.fire(undefined));
  }

  getTreeItem(node: EnvNode): vscode.TreeItem {
    if (node.kind === 'variable') {
      const env = this.services.environments.get(node.envId);
      const v = env?.variables.find((x) => x.key === node.key);
      const ti = new vscode.TreeItem(node.key ?? '');
      if (v) {
        ti.description = v.secret ? '••••••' : v.value;
        ti.iconPath = new vscode.ThemeIcon(v.secret ? 'lock' : 'symbol-variable');
        ti.contextValue = v.secret ? 'variable-secret' : 'variable';
        ti.tooltip = v.secret ? 'Secret (stored in VS Code SecretStorage)' : v.value;
        if (!v.enabled) ti.description = `${ti.description} (disabled)`;
      }
      return ti;
    }
    const env = this.services.environments.get(node.envId);
    const isActive = this.services.activeEnvironment?.id === node.envId;
    const ti = new vscode.TreeItem(env?.name ?? node.envId, vscode.TreeItemCollapsibleState.Collapsed);
    if (node.kind === 'globals') {
      ti.iconPath = new vscode.ThemeIcon('globe');
      ti.contextValue = 'globals';
      ti.description = 'always applied';
    } else {
      ti.iconPath = new vscode.ThemeIcon(isActive ? 'pass-filled' : 'server-environment');
      ti.contextValue = isActive ? 'environment-active' : 'environment';
      ti.description = isActive ? 'active' : undefined;
    }
    ti.command = { command: 'httpClient.openEnvironment', title: 'Manage Variables', arguments: [node] };
    return ti;
  }

  getChildren(node?: EnvNode): EnvNode[] {
    if (!node) {
      return [
        { kind: 'globals', envId: GLOBALS_ID },
        ...this.services.environments.list().map((e) => ({ kind: 'environment' as const, envId: e.id })),
      ];
    }
    if (node.kind === 'variable') return [];
    const env = this.services.environments.get(node.envId);
    return (env?.variables ?? []).map((v) => ({ kind: 'variable', envId: node.envId, key: v.key }));
  }
}
