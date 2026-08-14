/**
 * The storage-key rules, from both directions.
 *
 * A predicate like this is only worth anything if it rejects the crafted
 * shapes *and* still accepts every key the platform legitimately writes — a
 * rule that quietly rejects `biz/img/x.jpg` would break media attachment
 * entirely, and would do it in the path nobody tests by hand.
 */

import {
  MAX_STORAGE_KEY_BYTES,
  isSafeFilename,
  isSafeStorageKey,
} from './storage-key.util';

describe('isSafeStorageKey', () => {
  describe('accepts the keys the platform actually writes', () => {
    it.each([
      ['a nested media key', 'biz/img/x.jpg'],
      ['a document key', 'biz/docs/invoice.pdf'],
      ['a tenant-prefixed key', '9f1c/media/2026/08/note.ogg'],
      ['a flat key', 'photo.jpg'],
      ['a key with a dot in a segment', 'biz/v1.2/clip.mp4'],
      ['a key with a dash and underscore', 'biz/my-file_02.webp'],
      // A single dot is a path component, not a parent hop.
      ['a key with a single-dot segment', 'biz/./x.jpg'],
      ['a key containing but not equal to ..', 'biz/a..b/x.jpg'],
      ['a key ending in a dot-dot-something', 'biz/x..jpg'],
      ['a non-ASCII filename', 'biz/चित्र.jpg'],
      ['a key at exactly the byte limit', 'a'.repeat(MAX_STORAGE_KEY_BYTES)],
    ])('%s', (_label, key) => {
      expect(isSafeStorageKey(key)).toBe(true);
    });
  });

  describe('rejects keys that could point somewhere else', () => {
    it.each([
      ['a parent hop', 'biz/../../etc/passwd'],
      ['a leading parent hop', '../secret'],
      ['a trailing parent hop', 'biz/media/..'],
      ['a bare parent hop', '..'],
      ['an absolute path', '/etc/passwd'],
      ['an https URL', 'https://evil.test/payload'],
      ['an s3 URL', 's3://other-bucket/key'],
      ['a file URL', 'file:///etc/shadow'],
      ['a link-local URL', 'http://169.254.169.254/latest/meta-data/'],
      ['a backslash separator', 'biz\\..\\..\\secret'],
      ['an empty key', ''],
      ['a key one byte over the limit', 'a'.repeat(MAX_STORAGE_KEY_BYTES + 1)],
    ])('%s', (_label, key) => {
      expect(isSafeStorageKey(key)).toBe(false);
    });

    it('rejects a NUL-truncated key that would pass a suffix check', () => {
      // `endsWith('.jpg')` says yes; a C-backed consumer opens `biz/x`.
      const key = `biz/x${String.fromCharCode(0)}/../../secret.jpg`;
      expect(key.endsWith('.jpg')).toBe(true);
      expect(isSafeStorageKey(key)).toBe(false);
    });

    it('rejects a newline that could forge a log line or a header', () => {
      expect(isSafeStorageKey(`biz/x.jpg${String.fromCharCode(10)}injected`)).toBe(false);
    });

    it('counts the byte length, not the character length', () => {
      // Each of these is 4 bytes in UTF-8, so 300 of them exceed 1024 bytes
      // while being only 300 characters long.
      const key = '𝄞'.repeat(300);
      expect(key.length).toBeLessThan(MAX_STORAGE_KEY_BYTES);
      expect(isSafeStorageKey(key)).toBe(false);
    });
  });

  it.each([[null], [undefined], [42], [{}], [['biz/x.jpg']]])(
    'rejects the non-string %p',
    (value) => {
      expect(isSafeStorageKey(value)).toBe(false);
    },
  );
});

describe('isSafeFilename', () => {
  it.each([
    ['a plain name', 'invoice.pdf'],
    ['a name with spaces', 'my holiday photo.jpg'],
    ['a Devanagari name', 'बिल.pdf'],
    ['a name with dots', 'archive.tar.gz'],
  ])('accepts %s', (_label, name) => {
    expect(isSafeFilename(name)).toBe(true);
  });

  it.each([
    ['a traversal path', '../../.ssh/authorized_keys'],
    ['any path separator', 'dir/file.pdf'],
    ['a backslash path', 'dir\\file.pdf'],
    ['a bare parent', '..'],
    ['a bare dot', '.'],
    ['an empty name', ''],
  ])('rejects %s', (_label, name) => {
    expect(isSafeFilename(name)).toBe(false);
  });

  it('rejects a NUL-truncated name', () => {
    expect(isSafeFilename(`safe.jpg${String.fromCharCode(0)}.exe`)).toBe(false);
  });
});
