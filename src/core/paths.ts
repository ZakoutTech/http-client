import nodePath from 'node:path';

/** Last path segment, splitting on both `/` and `\\` (collections may be authored on another OS). */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

type PathImpl = Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'sep'>;

/**
 * Turns a picked file's absolute path into the form stored in a request: workspace-relative
 * (with `/`, so collections stay portable across OSes) when the file is inside `rootDir`,
 * otherwise the absolute path unchanged.
 */
export function toRequestPath(fsPath: string, rootDir: string | undefined, path: PathImpl = nodePath): string {
  if (!rootDir) return fsPath;
  const rel = path.relative(rootDir, fsPath);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return fsPath;
  return rel.split(path.sep).join('/');
}
