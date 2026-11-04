import { describe, expect, it } from 'vitest';
import { applyEnvironmentUpdate, toEnvironmentView } from '../../src/core/environmentView';
import { isWebviewToHost } from '../../src/shared/messages';
import { newRequest, type Environment } from '../../src/shared/model';

const env = (): Environment => ({
  version: 1,
  id: 'dev',
  name: 'Dev',
  variables: [
    { key: 'baseUrl', value: 'http://localhost', enabled: true },
    { key: 'token', value: 'TOP-SECRET', enabled: true, secret: true },
    { key: 'empty', value: '', enabled: false, secret: true },
  ],
});

describe('toEnvironmentView', () => {
  it('never exposes secret values to the webview', () => {
    const view = toEnvironmentView(env());
    expect(JSON.stringify(view)).not.toContain('TOP-SECRET');
    expect(view.variables[1]).toEqual({ key: 'token', value: '', enabled: true, secret: true, hasValue: true });
    expect(view.variables[2].hasValue).toBe(false);
    expect(view.variables[0]).toEqual({ key: 'baseUrl', value: 'http://localhost', enabled: true });
  });
});

describe('applyEnvironmentUpdate', () => {
  it('keeps stored secrets unless a new value is supplied', () => {
    const view = toEnvironmentView(env());
    view.variables[0].value = 'https://api';
    const merged = applyEnvironmentUpdate(env(), view, {});
    expect(merged.variables.map((v) => [v.key, v.value])).toEqual([
      ['baseUrl', 'https://api'],
      ['token', 'TOP-SECRET'],
      ['empty', ''],
    ]);
    expect(applyEnvironmentUpdate(env(), view, { token: 'NEW' }).variables[1].value).toBe('NEW');
  });

  it('moves a plain value into secret storage when marked secret', () => {
    const view = toEnvironmentView(env());
    view.variables[0] = { key: 'baseUrl', value: '', enabled: true, secret: true };
    expect(applyEnvironmentUpdate(env(), view, {}).variables[0]).toEqual({ key: 'baseUrl', value: 'http://localhost', enabled: true, secret: true });
  });

  it('uses the webview value when a secret becomes plain (never copies the secret)', () => {
    const view = toEnvironmentView(env());
    view.variables[1] = { key: 'token', value: '', enabled: true };
    expect(applyEnvironmentUpdate(env(), view, {}).variables[1]).toEqual({ key: 'token', value: '', enabled: true });
  });

  it('drops empty and duplicate keys, trims names, keeps the name when blank', () => {
    const view = toEnvironmentView(env());
    view.name = '  ';
    view.variables.push({ key: ' ', value: 'x', enabled: true }, { key: 'baseUrl', value: 'dup', enabled: true }, { key: ' added ', value: 'y', enabled: true });
    const merged = applyEnvironmentUpdate(env(), view, {});
    expect(merged.name).toBe('Dev');
    expect(merged.variables.map((v) => v.key)).toEqual(['baseUrl', 'token', 'empty', 'added']);
  });
});

describe('isWebviewToHost', () => {
  const req = newRequest('r1');

  it('accepts every well-formed message', () => {
    const valid = [
      { type: 'ready' },
      { type: 'updateRequest', request: req },
      { type: 'send', request: req },
      { type: 'copyAsCurl', request: req },
      { type: 'updateCollection', collectionId: 'c', patch: { name: 'n', description: '', variables: [{ key: 'a', value: 'b', enabled: true }], auth: { type: 'none' } } },
      { type: 'saveEnvironment', environment: { id: 'e', name: 'E', variables: [] }, secretUpdates: { a: 'b' } },
      { type: 'setActiveEnvironment', environmentId: null },
      { type: 'setActiveEnvironment', environmentId: 'e' },
      { type: 'action', action: 'importOpenApi' },
      { type: 'itemAction', action: 'rename', collectionId: 'c' },
      { type: 'itemAction', action: 'delete', collectionId: 'c', itemId: 'i' },
      { type: 'envAction', action: 'duplicate', environmentId: 'e' },
      { type: 'move', collectionId: 'c', itemId: 'i', targetCollectionId: 'c2', targetParentId: null, index: 0 },
      { type: 'cancel', requestId: 'r' },
      { type: 'saveResponse', requestId: 'r' },
    ];
    for (const m of valid) expect(isWebviewToHost(m), JSON.stringify(m)).toBe(true);
  });

  it('rejects malformed or unknown messages', () => {
    const invalid = [
      null,
      [],
      { type: 'nope' },
      { type: 'send', request: { ...req, method: 'TRACE' } },
      { type: 'send', request: { ...req, headers: [{ key: 1 }] } },
      { type: 'send', request: { ...req, auth: null } },
      { type: 'updateCollection', collectionId: 'c', patch: { variables: 'x' } },
      { type: 'updateCollection', collectionId: 'c', patch: { auth: 3 } },
      { type: 'saveEnvironment', environment: { id: 'e', name: 'E', variables: [] }, secretUpdates: { a: 1 } },
      { type: 'saveEnvironment', environment: { id: 'e', variables: [] }, secretUpdates: {} },
      { type: 'setActiveEnvironment', environmentId: 3 },
      { type: 'action', action: 'rm -rf' },
      { type: 'itemAction', action: 'explode', collectionId: 'c' },
      { type: 'envAction', action: 'rename' },
      { type: 'move', collectionId: 'c', itemId: 'i', targetCollectionId: 'c', targetParentId: null, index: -1 },
      { type: 'move', collectionId: 'c', itemId: 'i', targetCollectionId: 'c', targetParentId: 5 },
      { type: 'cancel' },
    ];
    for (const m of invalid) expect(isWebviewToHost(m), JSON.stringify(m)).toBe(false);
  });
});
