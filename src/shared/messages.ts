import { HTTP_METHODS, type Auth, type Collection, type RequestItem, type ResponseData, type Variable } from './model';

/** A variable as shown in the webview. Secret values are never sent: `value` is "" and `hasValue` tells if one is stored. */
export interface VariableView extends Variable {
  hasValue?: boolean;
}

export interface EnvironmentView {
  id: string;
  name: string;
  variables: VariableView[];
}

export interface WorkbenchState {
  collections: Collection[];
  globals: EnvironmentView;
  environments: EnvironmentView[];
  activeEnvironmentId: string | null;
  /** Keys available via {{$dotenv KEY}} (values are not sent). */
  dotenvKeys: string[];
}

export type CollectionTab = 'overview' | 'variables' | 'auth';

export type NavTarget =
  | { view: 'welcome' }
  | { view: 'request'; requestId: string }
  | { view: 'collection'; collectionId: string; tab?: CollectionTab }
  | { view: 'variables'; environmentId?: string };

export interface CollectionPatch {
  name?: string;
  description?: string;
  variables?: Variable[];
  auth?: Auth;
}

export type ItemAction = 'newRequest' | 'newFolder' | 'rename' | 'duplicate' | 'delete';
export type EnvAction = 'rename' | 'duplicate' | 'delete';
export type GlobalAction = 'newCollection' | 'importOpenApi' | 'newEnvironment';

/** Messages sent from the webview to the extension host. */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'updateRequest'; request: RequestItem }
  | { type: 'updateCollection'; collectionId: string; patch: CollectionPatch }
  | { type: 'saveEnvironment'; environment: EnvironmentView; secretUpdates: Record<string, string> }
  | { type: 'setActiveEnvironment'; environmentId: string | null }
  | { type: 'action'; action: GlobalAction }
  | { type: 'itemAction'; action: ItemAction; collectionId: string; itemId?: string }
  | { type: 'envAction'; action: EnvAction; environmentId: string }
  | { type: 'move'; collectionId: string; itemId: string; targetCollectionId: string; targetParentId: string | null; index?: number }
  | { type: 'send'; request: RequestItem }
  | { type: 'cancel'; requestId: string }
  | { type: 'saveResponse'; requestId: string }
  | { type: 'copyAsCurl'; request: RequestItem };

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | { type: 'state'; state: WorkbenchState }
  | { type: 'navigate'; target: NavTarget }
  | { type: 'sending'; requestId: string }
  | { type: 'response'; requestId: string; response: ResponseData; unresolved: string[] }
  | { type: 'error'; requestId?: string; message: string; unresolved?: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || isStr(v);

function isKeyValueList(v: unknown): boolean {
  return Array.isArray(v) && v.every((kv) => isObj(kv) && isStr(kv.key) && isStr(kv.value) && typeof kv.enabled === 'boolean');
}

const isAuth = (v: unknown): v is Auth => isObj(v) && isStr(v.type);

/** Structural validation of a request coming from the (untrusted) webview. */
export function isRequestItem(v: unknown): v is RequestItem {
  if (!isObj(v)) return false;
  if (v.type !== 'request' || !isStr(v.id) || !isStr(v.name) || !isStr(v.url)) return false;
  if (!(HTTP_METHODS as readonly string[]).includes(v.method as string)) return false;
  if (!isKeyValueList(v.params) || !isKeyValueList(v.headers)) return false;
  if (!isObj(v.body) || !isStr(v.body.type)) return false;
  return isAuth(v.auth);
}

function isPatch(v: unknown): v is CollectionPatch {
  if (!isObj(v) || !optStr(v.name) || !optStr(v.description)) return false;
  if (v.variables !== undefined && !isKeyValueList(v.variables)) return false;
  return v.auth === undefined || isAuth(v.auth);
}

function isEnvironmentView(v: unknown): v is EnvironmentView {
  return isObj(v) && isStr(v.id) && isStr(v.name) && isKeyValueList(v.variables);
}

const ITEM_ACTIONS: readonly string[] = ['newRequest', 'newFolder', 'rename', 'duplicate', 'delete'];
const ENV_ACTIONS: readonly string[] = ['rename', 'duplicate', 'delete'];
const GLOBAL_ACTIONS: readonly string[] = ['newCollection', 'importOpenApi', 'newEnvironment'];

export function isWebviewToHost(v: unknown): v is WebviewToHost {
  if (!isObj(v) || !isStr(v.type)) return false;
  switch (v.type) {
    case 'ready':
      return true;
    case 'updateRequest':
    case 'send':
    case 'copyAsCurl':
      return isRequestItem(v.request);
    case 'updateCollection':
      return isStr(v.collectionId) && isPatch(v.patch);
    case 'saveEnvironment':
      return (
        isEnvironmentView(v.environment) &&
        isObj(v.secretUpdates) &&
        Object.values(v.secretUpdates).every(isStr)
      );
    case 'setActiveEnvironment':
      return v.environmentId === null || isStr(v.environmentId);
    case 'action':
      return GLOBAL_ACTIONS.includes(v.action as string);
    case 'itemAction':
      return ITEM_ACTIONS.includes(v.action as string) && isStr(v.collectionId) && optStr(v.itemId);
    case 'envAction':
      return ENV_ACTIONS.includes(v.action as string) && isStr(v.environmentId);
    case 'move':
      return (
        isStr(v.collectionId) &&
        isStr(v.itemId) &&
        isStr(v.targetCollectionId) &&
        (v.targetParentId === null || isStr(v.targetParentId)) &&
        (v.index === undefined || (typeof v.index === 'number' && Number.isInteger(v.index) && v.index >= 0))
      );
    case 'cancel':
    case 'saveResponse':
      return isStr(v.requestId);
    default:
      return false;
  }
}
