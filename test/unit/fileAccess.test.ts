import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDotenvFile } from '../../src/core/dotenv';
import { filesOutsideRoot, isInsideRoot, isWithin } from '../../src/core/fileAccess';

let base: string;
let root: string;
let outside: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'httpclient-access-')));
  root = join(base, 'ws');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, 'in.txt'), 'in');
  await writeFile(join(outside, 'secret.txt'), 'secret');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('isWithin', () => {
  it('accepts the root and its descendants only', () => {
    expect(isWithin('/ws', '/ws', posix)).toBe(true);
    expect(isWithin('/ws', '/ws/a/b.txt', posix)).toBe(true);
    expect(isWithin('/ws', '/ws-other/a.txt', posix)).toBe(false);
    expect(isWithin('/ws', '/ws/../etc/passwd', posix)).toBe(false);
    expect(isWithin('/ws', '/ws/..foo/a', posix)).toBe(true);
  });

  it('handles Windows drives and case', () => {
    expect(isWithin('C:\\ws', 'c:\\WS\\a.txt', win32)).toBe(true);
    expect(isWithin('C:\\ws', 'D:\\ws\\a.txt', win32)).toBe(false);
  });
});

describe('isInsideRoot', () => {
  it('follows symlinks and checks the real location', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await symlink(outside, join(root, 'linkdir'));
    expect(await isInsideRoot(root, join(root, 'in.txt'))).toBe(true);
    expect(await isInsideRoot(root, join(root, 'link.txt'))).toBe(false);
    expect(await isInsideRoot(root, join(root, 'linkdir', 'new', 'file.json'))).toBe(false);
    expect(await isInsideRoot(root, join(root, 'not-yet', 'file.json'))).toBe(true);
    expect(await isInsideRoot(root, join(root, '..', 'outside', 'secret.txt'))).toBe(false);
  });
});

describe('filesOutsideRoot', () => {
  it('lists multipart/binary files whose real path is outside the workspace', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const multipart = {
      kind: 'multipart' as const,
      fields: [
        { name: 'a', value: 'in.txt', isFile: true },
        { name: 'b', value: join(outside, 'secret.txt'), isFile: true },
        { name: 'c', value: '../outside/secret.txt', isFile: true },
        { name: 'd', value: 'link.txt', isFile: true },
        { name: 'e', value: '/not/a/file/but/text', isFile: false },
      ],
    };
    const real = join(outside, 'secret.txt');
    expect(await filesOutsideRoot(multipart, root)).toEqual([
      { path: join(outside, 'secret.txt'), real },
      { path: '../outside/secret.txt', real },
      { path: 'link.txt', real },
    ]);
    expect(await filesOutsideRoot({ kind: 'file', path: 'in.txt' }, root)).toEqual([]);
    expect(await filesOutsideRoot({ kind: 'text', text: 'x' }, root)).toEqual([]);
  });

  it('reports missing files clearly', async () => {
    await expect(filesOutsideRoot({ kind: 'file', path: 'missing.bin' }, root)).rejects.toThrow('File not found: missing.bin');
  });
});

describe('loadDotenvFile', () => {
  it('reads the workspace .env', async () => {
    await writeFile(join(root, '.env'), 'A=1\n');
    expect(await loadDotenvFile(root)).toEqual({ A: '1' });
  });

  it('returns nothing when there is no .env', async () => {
    expect(await loadDotenvFile(root)).toEqual({});
  });

  it('refuses a .env symlinked to a file outside the workspace', async () => {
    await writeFile(join(outside, 'credentials'), 'aws_secret_access_key=shh\n');
    await symlink(join(outside, 'credentials'), join(root, '.env'));
    await expect(loadDotenvFile(root)).rejects.toThrow(/outside the workspace/);
  });
});
