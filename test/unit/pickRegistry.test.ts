import { beforeAll, describe, expect, it } from 'vitest';

const posted: unknown[] = [];
let store: typeof import('../../src/webview/store');

beforeAll(async () => {
  // store.ts talks to the VS Code webview API at import time; stub it.
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => posted.push(m),
    getState: () => undefined,
    setState: () => undefined,
  });
  store = await import('../../src/webview/store');
});

describe('file pick registry', () => {
  it('posts pickFiles and resolves with the matching filesPicked reply only once', async () => {
    const pending = store.pickFiles(true);
    const msg = posted.at(-1) as { type: string; pickId: string; many: boolean };
    expect(msg).toMatchObject({ type: 'pickFiles', many: true });

    store.resolvePick('unknown', ['ignored.png']);
    store.resolvePick(msg.pickId, ['a.png', 'b.png']);
    store.resolvePick(msg.pickId, ['late.png']); // duplicate reply is ignored
    await expect(pending).resolves.toEqual(['a.png', 'b.png']);
  });

  it('gives concurrent picks distinct ids', async () => {
    const first = store.pickFiles(false);
    const second = store.pickFiles(false);
    const [m1, m2] = posted.slice(-2) as { pickId: string }[];
    expect(m1.pickId).not.toBe(m2.pickId);
    store.resolvePick(m2.pickId, ['two']);
    store.resolvePick(m1.pickId, []);
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual(['two']);
  });
});
