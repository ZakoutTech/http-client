import { describe, expect, it } from 'vitest';
import {
  cloneWithNewIds,
  duplicateItem,
  effectiveAuth,
  findItem,
  insertItem,
  moveItem,
  removeItem,
} from '../../src/core/collectionOps';
import { newRequest, type Collection, type FolderItem } from '../../src/shared/model';

function fixture(): Collection {
  const folderB: FolderItem = { type: 'folder', id: 'fB', name: 'B', items: [newRequest('r3', 'R3')] };
  const folderA: FolderItem = {
    type: 'folder',
    id: 'fA',
    name: 'A',
    auth: { type: 'bearer', token: 'folder' },
    items: [newRequest('r2', 'R2'), folderB],
  };
  return {
    version: 1,
    id: 'c1',
    name: 'C',
    variables: [],
    auth: { type: 'basic', username: 'u', password: 'p' },
    items: [newRequest('r1', 'R1'), folderA],
  };
}

describe('collectionOps', () => {
  it('finds nested items with ancestors', () => {
    const found = findItem(fixture(), 'r3');
    expect(found?.ancestors.map((a) => a.id)).toEqual(['fA', 'fB']);
    expect(found?.index).toBe(0);
    expect(findItem(fixture(), 'nope')).toBeUndefined();
  });

  it('inserts at root, in folders and at an index', () => {
    const c = fixture();
    insertItem(c, null, newRequest('x'));
    insertItem(c, 'fB', newRequest('y'), 0);
    insertItem(c, c.id, newRequest('z'), 99);
    expect(c.items.map((i) => i.id)).toEqual(['r1', 'fA', 'x', 'z']);
    expect(findItem(c, 'y')?.index).toBe(0);
    expect(() => insertItem(c, 'r1', newRequest('bad'))).toThrow(/not found/);
  });

  it('removes items', () => {
    const c = fixture();
    expect(removeItem(c, 'r2')?.id).toBe('r2');
    expect(findItem(c, 'r2')).toBeUndefined();
    expect(removeItem(c, 'r2')).toBeUndefined();
  });

  it('moves items between folders and reorders within a parent', () => {
    const c = fixture();
    expect(moveItem(c, 'r1', 'fB')).toBe(true);
    expect(findItem(c, 'r1')?.ancestors.map((a) => a.id)).toEqual(['fA', 'fB']);
    expect(moveItem(c, 'r2', null, 0)).toBe(true);
    expect(c.items[0].id).toBe('r2');
    // Reorder within the same parent: move first item to index 2 (after fA).
    expect(moveItem(c, 'r2', null, 2)).toBe(true);
    expect(c.items.map((i) => i.id)).toEqual(['fA', 'r2']);
    expect(moveItem(c, 'missing', null)).toBe(false);
  });

  it('refuses to move a folder into its own descendant', () => {
    const c = fixture();
    expect(moveItem(c, 'fA', 'fB')).toBe(false);
    expect(moveItem(c, 'fA', 'fA')).toBe(false);
    expect(findItem(c, 'fA')?.ancestors).toEqual([]);
  });

  it('duplicates with fresh ids, placed after the original', () => {
    const c = fixture();
    const copy = duplicateItem(c, 'fA') as FolderItem;
    expect(copy.name).toBe('A Copy');
    expect(copy.id).not.toBe('fA');
    expect(copy.items[0].id).not.toBe('r2');
    expect(c.items[2]).toBe(copy);
    expect(duplicateItem(c, 'missing')).toBeUndefined();
    const clone = cloneWithNewIds(newRequest('q'));
    expect(clone.id).not.toBe('q');
  });

  it('resolves inherited auth through folders up to the collection', () => {
    const c = fixture();
    expect(effectiveAuth(c, 'r1')).toEqual({ type: 'basic', username: 'u', password: 'p' });
    expect(effectiveAuth(c, 'r3')).toEqual({ type: 'bearer', token: 'folder' });
    const r2 = findItem(c, 'r2')?.item;
    if (r2?.type === 'request') r2.auth = { type: 'none' };
    expect(effectiveAuth(c, 'r2')).toEqual({ type: 'none' });
    c.auth = { type: 'inherit' };
    expect(effectiveAuth(c, 'r1')).toEqual({ type: 'none' });
    expect(effectiveAuth(c, 'missing')).toEqual({ type: 'none' });
  });
});
