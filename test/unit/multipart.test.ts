import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mimeTypeFor } from '../../src/core/mime';
import { fileNameOf, toRequestPath } from '../../src/core/paths';
import { applyPickedFiles, duplicateField } from '../../src/shared/multipart';
import type { MultipartField } from '../../src/shared/model';

const field = (key: string, value: string, kind: MultipartField['kind'] = 'file'): MultipartField => ({ key, value, enabled: true, kind });

describe('mimeTypeFor', () => {
  it('maps common extensions case-insensitively', () => {
    expect(mimeTypeFor('photo.PNG')).toBe('image/png');
    expect(mimeTypeFor('dir/a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFor('report.pdf')).toBe('application/pdf');
    expect(mimeTypeFor('data.json')).toBe('application/json');
    expect(mimeTypeFor('rows.csv')).toBe('text/csv');
    expect(mimeTypeFor('C:\\files\\notes.txt')).toBe('text/plain');
  });

  it('falls back to application/octet-stream', () => {
    expect(mimeTypeFor('blob.unknownext')).toBe('application/octet-stream');
    expect(mimeTypeFor('Makefile')).toBe('application/octet-stream');
    expect(mimeTypeFor('.env')).toBe('application/octet-stream');
  });
});

describe('fileNameOf', () => {
  it('takes the last segment of POSIX and Windows paths', () => {
    expect(fileNameOf('uploads/a.png')).toBe('a.png');
    expect(fileNameOf('C:\\pics\\b.png')).toBe('b.png');
    expect(fileNameOf('plain.txt')).toBe('plain.txt');
  });
});

describe('toRequestPath', () => {
  it('returns a workspace-relative path for files inside the root', () => {
    expect(toRequestPath('/ws/project/fixtures/a.png', '/ws/project', posix)).toBe('fixtures/a.png');
  });

  it('keeps absolute paths for files outside the root or without a root', () => {
    expect(toRequestPath('/tmp/a.png', '/ws/project', posix)).toBe('/tmp/a.png');
    expect(toRequestPath('/ws/project-other/a.png', '/ws/project', posix)).toBe('/ws/project-other/a.png');
    expect(toRequestPath('/tmp/a.png', undefined, posix)).toBe('/tmp/a.png');
  });

  it('uses forward slashes for relative Windows paths and keeps other drives absolute', () => {
    expect(toRequestPath('C:\\ws\\proj\\files\\a.png', 'C:\\ws\\proj', win32)).toBe('files/a.png');
    expect(toRequestPath('D:\\a.png', 'C:\\ws\\proj', win32)).toBe('D:\\a.png');
  });
});

describe('applyPickedFiles', () => {
  it('fills the picked row and inserts extra files as rows with the same key (an array)', () => {
    const list = [field('avatar', ''), field('files[]', ''), field('note', 'hi', 'text')];
    applyPickedFiles(list, 1, ['a.png', 'b.png', 'c.png']);
    expect(list.map((f) => [f.key, f.value, f.kind])).toEqual([
      ['avatar', '', 'file'],
      ['files[]', 'a.png', 'file'],
      ['files[]', 'b.png', 'file'],
      ['files[]', 'c.png', 'file'],
      ['note', 'hi', 'text'],
    ]);
  });

  it('copies enabled state but not descriptions onto the inserted rows', () => {
    const list: MultipartField[] = [{ ...field('docs', 'old.pdf'), enabled: false, description: 'Docs' }];
    applyPickedFiles(list, 0, ['a.pdf', 'b.pdf']);
    expect(list[0]).toEqual({ key: 'docs', value: 'a.pdf', enabled: false, kind: 'file', description: 'Docs' });
    expect(list[1]).toEqual({ key: 'docs', value: 'b.pdf', enabled: false, kind: 'file' });
  });

  it('ignores an empty selection or a stale index', () => {
    const list = [field('a', 'x.png')];
    applyPickedFiles(list, 0, []);
    applyPickedFiles(list, 5, ['y.png']);
    expect(list).toEqual([field('a', 'x.png')]);
  });
});

describe('duplicateField', () => {
  it('inserts an empty value with the same key and kind right after the row', () => {
    const list = [field('tags', 'red', 'text'), field('end', 'z', 'text')];
    duplicateField(list, 0);
    expect(list).toEqual([field('tags', 'red', 'text'), field('tags', '', 'text'), field('end', 'z', 'text')]);
  });
});
