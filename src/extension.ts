import * as vscode from 'vscode';
import { Actions } from './vscode/actions';
import { CollectionsTree, type CollectionNode } from './vscode/collectionsTree';
import { registerCommands } from './vscode/commands';
import { EnvironmentsTree } from './vscode/environmentsTree';
import { Services } from './vscode/services';
import { Workbench } from './vscode/workbench';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') {
    const notice = () =>
      vscode.window.showWarningMessage('HTTP Client needs an open local folder to store collections in .httpclient/.');
    for (const id of ['httpClient.openWorkbench', 'httpClient.newCollection', 'httpClient.importOpenApi', 'httpClient.newEnvironment']) {
      context.subscriptions.push(vscode.commands.registerCommand(id, notice));
    }
    return;
  }

  const services = new Services(folder.uri.fsPath, context);
  const actions = new Actions(services);
  const workbench = new Workbench(services, actions, context.extensionUri);
  context.subscriptions.push(services, workbench);

  const collectionsTree = new CollectionsTree(services);
  const collectionsView = vscode.window.createTreeView<CollectionNode>('httpClient.collections', {
    treeDataProvider: collectionsTree,
    dragAndDropController: collectionsTree,
    canSelectMany: true,
    showCollapseAll: true,
  });
  const environmentsView = vscode.window.createTreeView('httpClient.environments', {
    treeDataProvider: new EnvironmentsTree(services),
  });
  context.subscriptions.push(collectionsView, environmentsView);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'httpClient.selectEnvironment';
  status.tooltip = 'HTTP Client: select environment';
  const updateStatus = () => {
    status.text = `$(server-environment) ${services.activeEnvironment?.name ?? 'No Environment'}`;
    status.show();
  };
  context.subscriptions.push(status, services.onDidChangeEnvironments(updateStatus));

  registerCommands(context, services, actions, workbench, collectionsView);

  await services.reload();
  updateStatus();
  if (services.collections.errors.length) {
    const first = services.collections.errors[0];
    void vscode.window.showWarningMessage(
      `HTTP Client: ${services.collections.errors.length} collection file(s) could not be loaded (e.g. ${first.file}: ${first.message}).`,
    );
  }
}

export function deactivate(): void {}
