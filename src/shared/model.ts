/**
 * Data model shared by the extension host, the webview and the on-disk format.
 * Every type here must stay JSON-serialisable.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

export interface MultipartField extends KeyValue {
  /** `text` sends `value` as-is; `file` treats `value` as a workspace-relative or absolute path. */
  kind: 'text' | 'file';
}

export type BodyType = 'none' | 'json' | 'text' | 'xml' | 'form' | 'multipart' | 'binary';

export interface RequestBody {
  type: BodyType;
  /** Used by json/text/xml. */
  raw?: string;
  /** Used by form (application/x-www-form-urlencoded). */
  form?: KeyValue[];
  /** Used by multipart (multipart/form-data). */
  multipart?: MultipartField[];
  /** Used by binary: path to a file. */
  file?: string;
}

export type Auth =
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  | {
      type: 'oauth2';
      grant: 'client_credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
      /** How client credentials are sent to the token endpoint (default: header = HTTP Basic). */
      clientAuthentication?: 'header' | 'body';
    };

export type AuthType = Auth['type'];

export interface RequestItem {
  type: 'request';
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: Auth;
  description?: string;
}

export interface FolderItem {
  type: 'folder';
  id: string;
  name: string;
  items: CollectionItem[];
  auth?: Auth;
}

export type CollectionItem = FolderItem | RequestItem;

export interface Collection {
  version: 1;
  id: string;
  name: string;
  description?: string;
  variables: Variable[];
  auth: Auth;
  items: CollectionItem[];
}

export interface Variable {
  key: string;
  value: string;
  enabled: boolean;
  /** When true the value is kept in SecretStorage and written to disk as "". */
  secret?: boolean;
}

export interface Environment {
  version: 1;
  id: string;
  name: string;
  variables: Variable[];
}

export interface ResponseData {
  status: number;
  statusText: string;
  headers: [string, string][];
  /** Body decoded as UTF-8 when textual, otherwise base64. */
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  contentType: string;
  sizeBytes: number;
  truncated: boolean;
  timings: { ttfbMs: number; totalMs: number };
  url: string;
  redirects: number;
}

export function newRequest(id: string, name = 'New Request'): RequestItem {
  return {
    type: 'request',
    id,
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { type: 'none' },
    auth: { type: 'inherit' },
  };
}
