/** Random id usable in both Node and the browser. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** Filesystem-safe slug for file names. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}
