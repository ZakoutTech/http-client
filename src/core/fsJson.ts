import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertInsideRoot } from './fileAccess';

/** Pretty, stable JSON with a trailing newline (git-friendly). */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Atomic write: temp file + rename, so a crash never leaves half-written JSON.
 * With `root`, refuses to write anywhere whose real location is outside it (e.g. a symlinked folder).
 */
export async function writeJsonAtomic(file: string, value: unknown, root?: string): Promise<void> {
  if (root) await assertInsideRoot(root, file);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, toJson(value), 'utf8');
  await rename(tmp, file);
}

/** Reads JSON; with `root`, refuses files whose real location is outside it (e.g. symlinks). */
export async function readJson(file: string, root?: string): Promise<unknown> {
  if (root) await assertInsideRoot(root, file);
  return JSON.parse(await readFile(file, 'utf8'));
}

export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
