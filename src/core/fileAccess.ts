import { realpath } from 'node:fs/promises';
import nodePath from 'node:path';
import type { ResolvedBody } from './requestBuilder';

/**
 * File-system containment for everything the extension reads or writes on the user's behalf.
 * The rule: only paths whose *real* location (after resolving `..` and symlinks) is inside the
 * workspace root are touched, unless the user explicitly allowed a specific file.
 */

export class FileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileAccessError';
  }
}

type PathImpl = Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'sep' | 'resolve'>;

/** True when `target` is `root` or below it (purely lexical; callers pass real paths). */
export function isWithin(root: string, target: string, path: PathImpl = nodePath): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Real path of `target`, or of its nearest existing ancestor joined with the missing tail. */
async function realOrAncestor(target: string): Promise<string> {
  const missing: string[] = [];
  let current = nodePath.resolve(target);
  for (;;) {
    try {
      return nodePath.join(await realpath(current), ...missing.reverse());
    } catch (err) {
      if (!isEnoent(err)) throw err;
      const parent = nodePath.dirname(current);
      if (parent === current) return nodePath.join(current, ...missing.reverse());
      missing.push(nodePath.basename(current));
      current = parent;
    }
  }
}

/** Whether `target` (which may not exist yet) really lives inside `root`, following symlinks. */
export async function isInsideRoot(root: string, target: string): Promise<boolean> {
  return isWithin(await realOrAncestor(root), await realOrAncestor(target));
}

/** Throws a FileAccessError unless `target` really lives inside `root`. */
export async function assertInsideRoot(root: string, target: string, what = 'File'): Promise<void> {
  if (!(await isInsideRoot(root, target))) {
    throw new FileAccessError(`${what} "${target}" is outside the workspace (symlinks and ".." are followed); refusing to access it.`);
  }
}

/** Resolves a request file path (relative to `baseDir`) to its real path; missing files get a clear error. */
export async function realFilePath(path: string, baseDir: string | undefined): Promise<string> {
  const full = nodePath.isAbsolute(path) || !baseDir ? path : nodePath.resolve(baseDir, path);
  try {
    return await realpath(full);
  } catch (err) {
    if (isEnoent(err)) throw new Error(`File not found: ${path}`);
    throw err;
  }
}

/** The local files a resolved body will read when sent. */
export function bodyFilePaths(body: ResolvedBody): string[] {
  if (body.kind === 'file') return [body.path];
  if (body.kind === 'multipart') return body.fields.filter((f) => f.isFile).map((f) => f.value);
  return [];
}

/** Files the body would upload from outside `root` (by real path), so the host can ask before sending. */
export async function filesOutsideRoot(body: ResolvedBody, root: string): Promise<{ path: string; real: string }[]> {
  const realRoot = await realOrAncestor(root);
  const out: { path: string; real: string }[] = [];
  for (const path of bodyFilePaths(body)) {
    const real = await realFilePath(path, root);
    if (!isWithin(realRoot, real)) out.push({ path, real });
  }
  return out;
}
