import type { MultipartField } from './model';

/**
 * Applies files chosen in the picker to the row at `index`: the first file fills that row and every
 * further file is inserted right after it as a new row with the same key. Repeated keys are how
 * multipart/form-data sends arrays (e.g. `files[]` × N).
 */
export function applyPickedFiles(list: MultipartField[], index: number, paths: string[]): void {
  const row = list[index];
  if (!row || !paths.length) return;
  row.kind = 'file';
  row.value = paths[0];
  const extra = paths.slice(1).map((value): MultipartField => ({ key: row.key, value, enabled: row.enabled, kind: 'file' }));
  list.splice(index + 1, 0, ...extra);
}

/** Inserts another (empty) value for the same key right after `index`, to build an array by hand. */
export function duplicateField(list: MultipartField[], index: number): void {
  const row = list[index];
  if (!row) return;
  list.splice(index + 1, 0, { key: row.key, value: '', enabled: row.enabled, kind: row.kind });
}
