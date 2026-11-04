/* eslint-disable @typescript-eslint/no-explicit-any -- traverses untyped OpenAPI documents */
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse as parseYaml } from 'yaml';
import type {
  Auth,
  Collection,
  FolderItem,
  HttpMethod,
  KeyValue,
  MultipartField,
  RequestBody,
  RequestItem,
  Variable,
} from '../../shared/model';
import { newId } from '../../shared/ids';
import { exampleToString, generateExample } from './example';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;

export interface ImportSource {
  /** Raw spec text (JSON or YAML). */
  text: string;
  /** File path or URL the spec came from; used as the base for relative $refs and server URLs. */
  location: string;
  isUrl: boolean;
}

export function parseSpecText(text: string): any {
  const trimmed = text.trimStart();
  let doc: unknown;
  try {
    doc = trimmed.startsWith('{') ? JSON.parse(trimmed) : parseYaml(text, { maxAliasCount: 1000 });
  } catch (err) {
    throw new Error(`Could not parse spec: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error('Spec is not an object');
  const d = doc as Record<string, unknown>;
  if (typeof d.swagger !== 'string' && typeof d.openapi !== 'string') {
    throw new Error('Not an OpenAPI/Swagger document (missing "openapi" or "swagger" field)');
  }
  if (typeof d.swagger === 'string' && !d.swagger.startsWith('2.')) {
    throw new Error(`Unsupported Swagger version ${d.swagger}`);
  }
  if (typeof d.openapi === 'string' && !/^3\.[01]\./.test(d.openapi)) {
    throw new Error(`Unsupported OpenAPI version ${d.openapi}`);
  }
  return doc;
}

/** Parses, dereferences and converts a spec into a collection. */
export async function importOpenApi(source: ImportSource): Promise<Collection> {
  const doc = parseSpecText(source.text);
  const api = await SwaggerParser.dereference(source.location, doc, {
    resolve: {
      // A spec downloaded from the network must never read local files via $ref.
      file: !source.isUrl,
      http: { timeout: 15_000 },
    },
    dereference: { circular: true },
  } as any);
  return convertSpec(api, source.isUrl ? source.location : undefined);
}

interface ConvertContext {
  vars: Map<string, string>;
  schemes: Map<string, Auth>;
}

/** Converts an already-dereferenced spec object into a Collection. */
export function convertSpec(api: any, specUrl?: string): Collection {
  const isV2 = typeof api.swagger === 'string';
  const ctx: ConvertContext = { vars: new Map([['baseUrl', baseUrlOf(api, isV2, specUrl)]]), schemes: new Map() };

  const schemeDefs: Record<string, any> = (isV2 ? api.securityDefinitions : api.components?.securitySchemes) ?? {};
  for (const [name, def] of Object.entries(schemeDefs)) {
    const auth = mapSecurityScheme(def, ctx, isV2);
    if (auth) ctx.schemes.set(name, auth);
  }
  const collectionSchemeName = firstSupportedScheme(api.security, ctx);
  const collectionAuth: Auth = collectionSchemeName ? (ctx.schemes.get(collectionSchemeName) as Auth) : { type: 'none' };

  const folders = new Map<string, FolderItem>();
  for (const tag of api.tags ?? []) {
    if (tag?.name && !folders.has(tag.name)) folders.set(tag.name, { type: 'folder', id: newId(), name: tag.name, items: [] });
  }
  const rootItems: RequestItem[] = [];

  for (const [path, pathItem] of Object.entries<any>(api.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const request = convertOperation(path, method, op, pathItem.parameters ?? [], api, isV2, ctx, collectionSchemeName);
      const tag: string | undefined = op.tags?.[0];
      if (tag) {
        if (!folders.has(tag)) folders.set(tag, { type: 'folder', id: newId(), name: tag, items: [] });
        (folders.get(tag) as FolderItem).items.push(request);
      } else {
        rootItems.push(request);
      }
    }
  }

  const variables: Variable[] = [...ctx.vars].map(([key, value]) => ({ key, value, enabled: true }));
  return {
    version: 1,
    id: newId(),
    name: api.info?.title || 'Imported API',
    description: api.info?.description,
    variables,
    auth: collectionAuth,
    items: [...[...folders.values()].filter((f) => f.items.length), ...rootItems],
  };
}

function baseUrlOf(api: any, isV2: boolean, specUrl?: string): string {
  let base = '';
  if (isV2) {
    const scheme = api.schemes?.[0] ?? (specUrl ? new URL(specUrl).protocol.replace(':', '') : 'https');
    const host = api.host ?? (specUrl ? new URL(specUrl).host : '');
    base = host ? `${scheme}://${host}${api.basePath ?? ''}` : (api.basePath ?? '');
  } else {
    const server = api.servers?.[0];
    if (server?.url) {
      base = String(server.url).replace(/\{([^}]+)\}/g, (whole: string, name: string) => {
        const def = server.variables?.[name]?.default;
        return def !== undefined ? String(def) : whole;
      });
    }
  }
  if (specUrl && base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) {
    base = new URL(base, specUrl).toString();
  }
  return base.replace(/\/+$/, '');
}

function addVar(ctx: ConvertContext, key: string, value = ''): string {
  if (!ctx.vars.has(key)) ctx.vars.set(key, value);
  return `{{${key}}}`;
}

function mapSecurityScheme(def: any, ctx: ConvertContext, isV2: boolean): Auth | undefined {
  if (!def || typeof def !== 'object') return undefined;
  const type = def.type;
  if ((isV2 && type === 'basic') || (type === 'http' && /^basic$/i.test(def.scheme ?? ''))) {
    return { type: 'basic', username: addVar(ctx, 'username'), password: addVar(ctx, 'password') };
  }
  if (type === 'http' && /^bearer$/i.test(def.scheme ?? '')) {
    return { type: 'bearer', token: addVar(ctx, 'token') };
  }
  if (type === 'apiKey' && (def.in === 'header' || def.in === 'query') && def.name) {
    return { type: 'apikey', key: def.name, value: addVar(ctx, 'apiKey'), in: def.in };
  }
  if (type === 'oauth2') {
    const tokenUrl = isV2
      ? def.flow === 'application'
        ? def.tokenUrl
        : undefined
      : def.flows?.clientCredentials?.tokenUrl;
    if (!tokenUrl) return undefined;
    const scopes = Object.keys((isV2 ? def.scopes : def.flows.clientCredentials.scopes) ?? {});
    return {
      type: 'oauth2',
      grant: 'client_credentials',
      tokenUrl,
      clientId: addVar(ctx, 'clientId'),
      clientSecret: addVar(ctx, 'clientSecret'),
      scope: scopes.join(' ') || undefined,
    };
  }
  return undefined;
}

function firstSupportedScheme(security: any, ctx: ConvertContext): string | undefined {
  if (!Array.isArray(security)) return undefined;
  for (const requirement of security) {
    for (const name of Object.keys(requirement ?? {})) if (ctx.schemes.has(name)) return name;
  }
  return undefined;
}

function mergeParameters(pathLevel: any[], opLevel: any[]): any[] {
  const byKey = new Map<string, any>();
  for (const p of [...pathLevel, ...opLevel]) if (p?.name && p?.in) byKey.set(`${p.in}:${p.name}`, p);
  return [...byKey.values()];
}

function paramExample(p: any): string {
  const schema = p.schema ?? p; // Swagger 2 non-body params carry type/format inline.
  const examples = p.examples ? Object.values<any>(p.examples) : [];
  const value = p.example ?? examples[0]?.value ?? p.default ?? generateExample(schema);
  return exampleToString(value);
}

function convertOperation(
  path: string,
  method: (typeof METHODS)[number],
  op: any,
  pathParams: any[],
  api: any,
  isV2: boolean,
  ctx: ConvertContext,
  collectionSchemeName: string | undefined,
): RequestItem {
  const params = mergeParameters(pathParams, op.parameters ?? []);
  const query: KeyValue[] = [];
  const headers: KeyValue[] = [];

  for (const p of params.filter((x) => x.in === 'path')) addVar(ctx, p.name, paramExample(p));
  for (const p of params.filter((x) => x.in === 'query')) {
    query.push({ key: p.name, value: paramExample(p), enabled: !!p.required, description: p.description });
  }
  for (const p of params.filter((x) => x.in === 'header')) {
    if (/^(content-type|accept|authorization)$/i.test(p.name)) continue;
    headers.push({ key: p.name, value: paramExample(p), enabled: !!p.required, description: p.description });
  }

  const urlPath = path.replace(/\{([^}]+)\}/g, (_w, name: string) => `{{${name}}}`);
  const { body, contentType } = isV2 ? v2Body(op, params, api) : v3Body(op);
  const defaultTypes: Record<string, string> = {
    json: 'application/json',
    xml: 'application/xml',
    text: 'text/plain',
    form: 'application/x-www-form-urlencoded',
  };
  if (contentType && defaultTypes[body.type] && defaultTypes[body.type] !== contentType) {
    headers.unshift({ key: 'Content-Type', value: contentType, enabled: true });
  }

  let auth: Auth = { type: 'inherit' };
  if (Array.isArray(op.security)) {
    const name = firstSupportedScheme(op.security, ctx);
    if (op.security.length === 0 || !name) auth = { type: 'none' };
    else if (name !== collectionSchemeName) auth = ctx.schemes.get(name) as Auth;
  }

  return {
    type: 'request',
    id: newId(),
    name: op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase() as HttpMethod,
    url: `{{baseUrl}}${urlPath}`,
    params: query,
    headers,
    body,
    auth,
    description: op.description,
  };
}

function pickMediaType(content: Record<string, any>): string | undefined {
  const types = Object.keys(content);
  return (
    types.find((t) => /^application\/json\b/i.test(t)) ??
    types.find((t) => /\+json\b/i.test(t)) ??
    types.find((t) => /x-www-form-urlencoded/i.test(t)) ??
    types.find((t) => /multipart\/form-data/i.test(t)) ??
    types.find((t) => /xml/i.test(t)) ??
    types.find((t) => /^text\//i.test(t)) ??
    types[0]
  );
}

function fieldsFromSchema(schema: any, example: unknown): { key: string; value: string; isFile: boolean }[] {
  const props: Record<string, any> = schema?.properties ?? {};
  const ex = example && typeof example === 'object' ? (example as Record<string, unknown>) : {};
  return Object.entries(props).map(([key, prop]) => ({
    key,
    value: prop?.format === 'binary' || prop?.type === 'file' ? '' : exampleToString(ex[key] ?? generateExample(prop)),
    isFile: prop?.format === 'binary' || prop?.type === 'file',
  }));
}

function bodyFor(mediaType: string, schema: any, example: unknown): RequestBody {
  if (/x-www-form-urlencoded/i.test(mediaType)) {
    return { type: 'form', form: fieldsFromSchema(schema, example).map(({ key, value }) => ({ key, value, enabled: true })) };
  }
  if (/multipart\/form-data/i.test(mediaType)) {
    const multipart: MultipartField[] = fieldsFromSchema(schema, example).map(({ key, value, isFile }) => ({
      key,
      value,
      enabled: true,
      kind: isFile ? 'file' : 'text',
    }));
    return { type: 'multipart', multipart };
  }
  if (/json/i.test(mediaType)) {
    return { type: 'json', raw: example === undefined ? '' : JSON.stringify(example, null, 2) };
  }
  if (/xml/i.test(mediaType)) return { type: 'xml', raw: typeof example === 'string' ? example : '' };
  if (/octet-stream|^image\/|^audio\/|^video\//i.test(mediaType)) return { type: 'binary' };
  return { type: 'text', raw: typeof example === 'string' ? example : exampleToString(example) };
}

function v3Body(op: any): { body: RequestBody; contentType?: string } {
  const content = op.requestBody?.content;
  if (!content || typeof content !== 'object') return { body: { type: 'none' } };
  const mediaType = pickMediaType(content);
  if (!mediaType) return { body: { type: 'none' } };
  const media = content[mediaType] ?? {};
  const examples = media.examples ? Object.values<any>(media.examples) : [];
  const example = media.example ?? examples[0]?.value ?? generateExample(media.schema);
  return { body: bodyFor(mediaType, media.schema, example), contentType: mediaType };
}

function v2Body(op: any, params: any[], api: any): { body: RequestBody; contentType?: string } {
  const consumes: string[] = op.consumes ?? api.consumes ?? [];
  const bodyParam = params.find((p) => p.in === 'body');
  if (bodyParam) {
    const mediaType = pickMediaType(Object.fromEntries((consumes.length ? consumes : ['application/json']).map((c) => [c, {}])));
    const example = bodyParam.schema?.example ?? generateExample(bodyParam.schema);
    return { body: bodyFor(mediaType ?? 'application/json', bodyParam.schema, example), contentType: mediaType };
  }
  const formParams = params.filter((p) => p.in === 'formData');
  if (!formParams.length) return { body: { type: 'none' } };
  const multipart = formParams.some((p) => p.type === 'file') || consumes.some((c) => /multipart/i.test(c));
  const schema = { properties: Object.fromEntries(formParams.map((p) => [p.name, p])) };
  return {
    body: bodyFor(multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded', schema, undefined),
    contentType: multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
  };
}
