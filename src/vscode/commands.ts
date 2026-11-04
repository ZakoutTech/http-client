import * as vscode from 'vscode';
import type { Variable } from '../shared/model';
import type { Actions } from './actions';
import type { CollectionNode } from './collectionsTree';
import type { EnvNode } from './environmentsTree';
import type { Services } from './services';
import type { Workbench } from './workbench';

export function registerCommands(
  context: vscode.ExtensionContext,
  services: Services,
  actions: Actions,
  workbench: Workbench,
  treeView: vscode.TreeView<CollectionNode>,
): void {
  const reg = (id: string, fn: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          await fn(...args);
        } catch (err) {
          void vscode.window.showErrorMessage(`HTTP Client: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

  const selected = (node?: CollectionNode): CollectionNode | undefined => node ?? treeView.selection[0];
  const parentOf = (n: CollectionNode) => (n.kind === 'collection' ? null : n.id);

  // ---------- Workbench ----------

  reg('httpClient.openWorkbench', () => workbench.show());
  reg('httpClient.manageVariables', () => workbench.show({ view: 'variables', environmentId: services.activeEnvironment?.id }));
  reg('httpClient.refresh', () => services.reload());

  // ---------- Collections ----------

  reg('httpClient.newCollection', async () => {
    const id = await actions.newCollection();
    if (id) workbench.show({ view: 'collection', collectionId: id });
  });

  reg('httpClient.importOpenApi', async () => {
    const id = await actions.importOpenApi();
    if (id) workbench.show({ view: 'collection', collectionId: id });
  });

  reg('httpClient.newFolder', async (node?: CollectionNode) => {
    const n = selected(node);
    if (n && n.kind !== 'request') await actions.newFolder(n.collectionId, parentOf(n));
  });

  reg('httpClient.newRequest', async (node?: CollectionNode) => {
    const n = selected(node);
    if (!n || n.kind === 'request') return;
    workbench.show({ view: 'request', requestId: await actions.newRequest(n.collectionId, parentOf(n)) });
  });

  reg('httpClient.openRequest', (node?: CollectionNode) => {
    const n = selected(node);
    if (n?.kind === 'request') workbench.show({ view: 'request', requestId: n.id });
  });

  reg('httpClient.openCollection', (node?: CollectionNode) => {
    const n = selected(node);
    if (n) workbench.show({ view: 'collection', collectionId: n.collectionId });
  });

  reg('httpClient.rename', async (node?: CollectionNode) => {
    const n = selected(node);
    if (n) await actions.rename(n.collectionId, n.kind === 'collection' ? undefined : n.id);
  });

  reg('httpClient.duplicate', async (node?: CollectionNode) => {
    const n = selected(node);
    if (n) await actions.duplicate(n.collectionId, n.kind === 'collection' ? undefined : n.id);
  });

  reg('httpClient.delete', async (node?: CollectionNode) => {
    const n = selected(node);
    if (n) await actions.remove(n.collectionId, n.kind === 'collection' ? undefined : n.id);
  });

  // ---------- Environments ----------

  reg('httpClient.newEnvironment', async () => {
    const id = await actions.newEnvironment();
    if (id) workbench.show({ view: 'variables', environmentId: id });
  });

  reg('httpClient.selectEnvironment', async () => {
    const items = [
      { label: '$(circle-slash) No Environment', id: undefined as string | undefined },
      ...services.environments.list().map((e) => ({
        label: `${services.activeEnvironment?.id === e.id ? '$(pass-filled) ' : ''}${e.name}`,
        id: e.id as string | undefined,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select the active environment' });
    if (picked) await services.setActiveEnvironment(picked.id);
  });

  reg('httpClient.openEnvironment', (node?: EnvNode) => workbench.show({ view: 'variables', environmentId: node?.envId }));

  reg('httpClient.activateEnvironment', (node?: EnvNode) => {
    if (node?.kind === 'environment') return services.setActiveEnvironment(node.envId);
  });

  reg('httpClient.deleteEnvironment', (node?: EnvNode) => node && actions.deleteEnvironment(node.envId));

  const editEnv = async (envId: string, mutate: (vars: Variable[]) => void) => {
    const env = services.environments.get(envId);
    if (!env) return;
    const copy = structuredClone(env);
    mutate(copy.variables);
    await services.saveEnvironment(copy);
  };

  reg('httpClient.addVariable', async (node?: EnvNode) => {
    const env = node && services.environments.get(node.envId);
    if (!node || !env) return;
    const key = await vscode.window.showInputBox({
      prompt: 'Variable name',
      validateInput: (v) =>
        !/^[A-Za-z_][\w.-]*$/.test(v) ? 'Use letters, digits, _, . or -' : env.variables.some((x) => x.key === v) ? 'Already exists' : undefined,
    });
    if (!key) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: '$(symbol-variable) Plain', secret: false, detail: 'Stored in the environment file (committed to git).' },
        { label: '$(lock) Secret', secret: true, detail: 'Stored in VS Code SecretStorage; the file keeps an empty value.' },
      ],
      { placeHolder: 'Variable type' },
    );
    if (!kind) return;
    const value = await vscode.window.showInputBox({ prompt: `Value for ${key}`, password: kind.secret });
    if (value === undefined) return;
    await editEnv(node.envId, (vars) => vars.push({ key, value, enabled: true, ...(kind.secret ? { secret: true } : {}) }));
  });

  reg('httpClient.editVariable', async (node?: EnvNode) => {
    const v = node && services.environments.get(node.envId)?.variables.find((x) => x.key === node.key);
    if (!node || !v) return;
    const value = await vscode.window.showInputBox({ prompt: `Value for ${v.key}`, value: v.secret ? '' : v.value, password: !!v.secret });
    if (value === undefined) return;
    await editEnv(node.envId, (vars) => {
      const target = vars.find((x) => x.key === node.key);
      if (target) target.value = value;
    });
  });

  reg('httpClient.toggleSecret', (node?: EnvNode) =>
    node &&
    editEnv(node.envId, (vars) => {
      const target = vars.find((x) => x.key === node.key);
      if (!target) return;
      if (target.secret) delete target.secret;
      else target.secret = true;
    }),
  );

  reg('httpClient.deleteVariable', (node?: EnvNode) =>
    node &&
    editEnv(node.envId, (vars) => {
      const i = vars.findIndex((x) => x.key === node.key);
      if (i >= 0) vars.splice(i, 1);
    }),
  );
}
