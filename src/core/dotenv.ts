import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertInsideRoot } from './fileAccess';

/**
 * Minimal .env parser: KEY=VALUE lines, optional `export ` prefix, # comments,
 * single quotes (literal) and double quotes (with \n, \r, \t, \", \\ escapes).
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    out[key] = parseValue(rest);
  }
  return out;
}

function parseValue(rest: string): string {
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    return end === -1 ? rest.slice(1) : rest.slice(1, end);
  }
  if (rest.startsWith('"')) {
    let value = '';
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === '\\' && i + 1 < rest.length) {
        const next = rest[++i];
        value += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
      } else if (ch === '"') {
        return value;
      } else {
        value += ch;
      }
    }
    return value;
  }
  // Unquoted: strip inline comment introduced by whitespace + #.
  const comment = rest.search(/\s#/);
  return (comment === -1 ? rest : rest.slice(0, comment)).trim();
}

/** Reads `<root>/.env` (empty if absent). Refuses a .env that is a symlink to a file outside the workspace. */
export async function loadDotenvFile(root: string): Promise<Record<string, string>> {
  const file = join(root, '.env');
  try {
    await assertInsideRoot(root, file, '.env file');
    return parseDotenv(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw err;
  }
}
