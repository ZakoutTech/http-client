/* eslint-disable @typescript-eslint/no-explicit-any -- walks untyped, possibly circular JSON Schema */

const MAX_DEPTH = 8;

const STRING_FORMATS: Record<string, string> = {
  'date-time': '2024-01-01T00:00:00Z',
  date: '2024-01-01',
  time: '00:00:00',
  email: 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '127.0.0.1',
  ipv6: '::1',
  byte: 'c3RyaW5n',
  binary: '',
  password: 'password',
};

function primaryType(schema: any): string | undefined {
  const t = schema.type;
  if (Array.isArray(t)) return t.find((x) => x !== 'null') ?? t[0];
  if (typeof t === 'string') return t;
  if (schema.properties || schema.additionalProperties) return 'object';
  if (schema.items) return 'array';
  return undefined;
}

/**
 * Generates an example value for a (dereferenced) JSON Schema / OpenAPI schema.
 * Prefers explicit example/default/enum values; handles allOf/oneOf/anyOf and circular schemas.
 * `mode` controls whether readOnly (request) or writeOnly (response) properties are skipped.
 */
export function generateExample(schema: any, mode: 'request' | 'response' = 'request'): unknown {
  return gen(schema, 0, new Set(), mode);
}

function gen(schema: any, depth: number, stack: Set<object>, mode: 'request' | 'response'): unknown {
  if (!schema || typeof schema !== 'object') return undefined;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (depth > MAX_DEPTH || stack.has(schema)) return undefined;

  stack.add(schema);
  try {
    if (Array.isArray(schema.allOf)) {
      const merged: Record<string, unknown> = {};
      let nonObject: unknown;
      for (const part of schema.allOf) {
        const v = gen(part, depth + 1, stack, mode);
        if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v);
        else if (v !== undefined) nonObject = v;
      }
      if (schema.properties) Object.assign(merged, genObject(schema, depth, stack, mode));
      return Object.keys(merged).length ? merged : nonObject;
    }
    const variants = schema.oneOf ?? schema.anyOf;
    if (Array.isArray(variants) && variants.length) {
      const nonNull = variants.find((v: any) => v?.type !== 'null') ?? variants[0];
      return gen(nonNull, depth + 1, stack, mode);
    }

    switch (primaryType(schema)) {
      case 'object':
        return genObject(schema, depth, stack, mode);
      case 'array': {
        const item = gen(schema.items, depth + 1, stack, mode);
        return item === undefined ? [] : [item];
      }
      case 'string':
        return STRING_FORMATS[schema.format] ?? 'string';
      case 'integer':
      case 'number':
        return typeof schema.minimum === 'number' ? schema.minimum : 0;
      case 'boolean':
        return true;
      case 'null':
        return null;
      default:
        return undefined;
    }
  } finally {
    stack.delete(schema);
  }
}

function genObject(schema: any, depth: number, stack: Set<object>, mode: 'request' | 'response'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
    if (mode === 'request' && prop?.readOnly) continue;
    if (mode === 'response' && prop?.writeOnly) continue;
    const v = gen(prop, depth + 1, stack, mode);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** Converts an example value into a string for a form field / query param. */
export function exampleToString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
