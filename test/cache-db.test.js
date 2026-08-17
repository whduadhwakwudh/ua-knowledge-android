import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { openKnowledgeDb, DB_NAME } from '../src/cache-db.js';

/**
 * Knowledge cache tests — run against fake-indexeddb (no network, no real
 * browser storage). Every test starts from a freshly deleted database so the
 * store schema and per-store state are deterministic.
 */

const REV_A = 'a'.repeat(64);
const REV_B = 'b'.repeat(64);
const REV_C = 'c'.repeat(64);
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const HASH_3 = '3'.repeat(64);

const DOC_ENTRY = (relativePath, sha256) => ({
  id: 'i'.repeat(43),
  relativePath,
  kind: 'document',
  mime: 'text/markdown; charset=utf-8',
  size: 12,
  mtime: '2026-01-01T00:00:00Z',
  sha256,
  title: 'Doc ' + relativePath,
});

const ARTIFACT_ENTRY = (relativePath, sha256) => ({
  id: 'j'.repeat(43),
  relativePath,
  kind: 'artifact',
  mime: 'application/vnd.android.package-archive',
  size: 4096,
  mtime: '2026-01-02T00:00:00Z',
  sha256,
  title: 'Apk ' + relativePath,
});

function makeManifest(revision, entries) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-02-01T00:00:00Z',
    revision,
    entries,
  };
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database deletion blocked'));
  });
}

let kb;
beforeEach(async () => {
  if (kb) {
    kb.db.close();
    kb = null;
  }
  await deleteDatabase(DB_NAME);
  kb = await openKnowledgeDb();
});

afterAll(() => {
  if (kb) {
    kb.db.close();
    kb = null;
  }
});

describe('openKnowledgeDb — schema', () => {
  it('creates the mandated object stores', async () => {
    // The upgrade callback must create all five stores regardless of which
    // code path is exercised first.
    const names = Array.from(kb.db.objectStoreNames).sort();
    expect(names).toEqual(['contents', 'favorites', 'manifests', 'meta', 'searchIndexes']);
  });

  it('opens the mandated database name', () => {
    expect(kb.db.name).toBe(DB_NAME);
  });

  it('searchIndexes records are keyed by revision and round-trip', async () => {
    const tx = kb.db.transaction('searchIndexes', 'readwrite');
    const store = tx.objectStore('searchIndexes');
    await store.put({ revision: REV_A, json: '{"documentCount":2}' });
    await tx.done;

    const read = await kb.db.transaction('searchIndexes').objectStore('searchIndexes').get(REV_A);
    expect(read).toEqual({ revision: REV_A, json: '{"documentCount":2}' });
    expect(read.json).toEqual('{"documentCount":2}');
  });
});

describe('active revision lifecycle', () => {
  it('staging writes manifest + contents without changing the active revision', async () => {
    expect(await kb.getActiveRevision()).toBeNull();

    const manifest = makeManifest(REV_A, [DOC_ENTRY('wiki/a.md', HASH_1)]);
    await kb.stageManifest({ revision: REV_A, manifest, contents: [{ sha256: HASH_1, text: '# staged' }] });

    // Staged data is readable, but nothing became active.
    expect(await kb.getActiveRevision()).toBeNull();
    expect(await kb.getManifest(REV_A)).toEqual(manifest);
    expect(await kb.getDocumentText(HASH_1)).toBe('# staged');
    expect(await kb.getActiveManifest()).toBeUndefined();
  });

  it('commitRevision switches the active revision in one transaction', async () => {
    const manifest = makeManifest(REV_A, [DOC_ENTRY('wiki/a.md', HASH_1)]);
    await kb.commitRevision({
      revision: REV_A,
      manifest,
      contents: [{ sha256: HASH_1, text: '# committed' }],
    });

    expect(await kb.getActiveRevision()).toBe(REV_A);
    expect(await kb.getActiveManifest()).toEqual(manifest);
    expect(await kb.getManifest(REV_A)).toEqual(manifest);
    expect(await kb.getDocumentText(HASH_1)).toBe('# committed');
  });

  it('a mid-transaction write failure leaves the previous revision fully readable', async () => {
    const manifestA = makeManifest(REV_A, [DOC_ENTRY('wiki/a.md', HASH_1)]);
    await kb.commitRevision({ revision: REV_A, manifest: manifestA, contents: [{ sha256: HASH_1, text: '# a' }] });

    // The manifest record for REV_B carries an un-cloneable value (a function),
    // so the very first write of the REV_B commit transaction throws
    // DataCloneError mid-transaction and the whole transaction aborts — the
    // meta.activeRevision write must never land.
    const manifestB = makeManifest(REV_B, [DOC_ENTRY('wiki/b.md', HASH_2)]);
    manifestB.entries[0].mtime = () => 'not-cloneable';
    await expect(
      kb.commitRevision({ revision: REV_B, manifest: manifestB, contents: [{ sha256: HASH_2, text: '# b' }] }),
    ).rejects.toThrow();

    // Previous revision still fully readable; nothing of REV_B exists.
    expect(await kb.getActiveRevision()).toBe(REV_A);
    expect(await kb.getActiveManifest()).toEqual(manifestA);
    expect(await kb.getManifest(REV_B)).toBeUndefined();
    expect(await kb.getDocumentText(HASH_1)).toBe('# a');
    expect(await kb.getDocumentText(HASH_2)).toBeUndefined();
  });

  it('commitRevision stamps meta.lastSyncAt as an ISO datetime', async () => {
    const manifest = makeManifest(REV_A, [DOC_ENTRY('wiki/a.md', HASH_1)]);
    await kb.commitRevision({ revision: REV_A, manifest, contents: [{ sha256: HASH_1, text: '# a' }] });

    const lastSyncAt = await kb.db.transaction('meta').objectStore('meta').get('lastSyncAt');
    expect(typeof lastSyncAt).toBe('string');
    expect(new Date(lastSyncAt).toISOString()).toBe(lastSyncAt);
  });
});

describe('gcUnreferenced', () => {
  it('removes only content hashes unreferenced by the retained current + previous manifests', async () => {
    // Rev A stores hashes 1 and 2.
    const manifestA = makeManifest(REV_A, [DOC_ENTRY('wiki/a.md', HASH_1), DOC_ENTRY('wiki/b.md', HASH_2)]);
    await kb.commitRevision({
      revision: REV_A,
      manifest: manifestA,
      contents: [
        { sha256: HASH_1, text: '# a' },
        { sha256: HASH_2, text: '# b' },
      ],
    });
    await kb.gcUnreferenced();
    expect(await kb.getDocumentText(HASH_1)).toBe('# a');
    expect(await kb.getDocumentText(HASH_2)).toBe('# b');

    // Rev B keeps hash 1, adds hash 3. Hash 2 is still referenced by the
    // previous manifest (REV_A) so it survives the first gc pass.
    const manifestB = makeManifest(REV_B, [DOC_ENTRY('wiki/a.md', HASH_1), DOC_ENTRY('wiki/c.md', HASH_3)]);
    await kb.commitRevision({
      revision: REV_B,
      manifest: manifestB,
      contents: [{ sha256: HASH_3, text: '# c' }],
    });
    await kb.gcUnreferenced();
    expect(await kb.getDocumentText(HASH_1)).toBe('# a');
    expect(await kb.getDocumentText(HASH_2)).toBe('# b');
    expect(await kb.getDocumentText(HASH_3)).toBe('# c');

    // Rev C keeps only hash 3. Retained manifests are now REV_B (previous,
    // referencing 1 and 3) and REV_C (current, referencing 3) — hash 2 is
    // unreferenced by both and must be collected; hash 1 stays (previous)
    // and hash 3 stays (both).
    const manifestC = makeManifest(REV_C, [DOC_ENTRY('wiki/c.md', HASH_3)]);
    await kb.commitRevision({ revision: REV_C, manifest: manifestC, contents: [] });
    await kb.gcUnreferenced();
    expect(await kb.getDocumentText(HASH_1)).toBe('# a');
    expect(await kb.getDocumentText(HASH_2)).toBeUndefined();
    expect(await kb.getDocumentText(HASH_3)).toBe('# c');
  });

  it('keeps only the current and previous manifests after a commit (rollback window)', async () => {
    const manifestA = makeManifest(REV_A, [DOC_ENTRY('wiki/a.md', HASH_1)]);
    await kb.commitRevision({ revision: REV_A, manifest: manifestA, contents: [{ sha256: HASH_1, text: '# a' }] });

    const manifestB = makeManifest(REV_B, [DOC_ENTRY('wiki/b.md', HASH_2)]);
    await kb.commitRevision({ revision: REV_B, manifest: manifestB, contents: [{ sha256: HASH_2, text: '# b' }] });

    const manifestC = makeManifest(REV_C, [DOC_ENTRY('wiki/c.md', HASH_3)]);
    await kb.commitRevision({ revision: REV_C, manifest: manifestC, contents: [{ sha256: HASH_3, text: '# c' }] });

    expect(await kb.getManifest(REV_A)).toBeUndefined();
    expect(await kb.getManifest(REV_B)).toEqual(manifestB);
    expect(await kb.getManifest(REV_C)).toEqual(manifestC);
    // Contents stay content-addressed regardless of manifest retention.
    expect(await kb.getDocumentText(HASH_2)).toBe('# b');
  });

  it('is a no-op with no active revision', async () => {
    await expect(kb.gcUnreferenced()).resolves.toBeUndefined();
    expect(await kb.getDocumentText(HASH_1)).toBeUndefined();
  });
});

describe('favorites', () => {
  it('starts empty and lists nothing', async () => {
    expect(await kb.listFavorites()).toEqual([]);
    expect(await kb.isFavorite('wiki/a.md')).toBe(false);
  });

  it('persists boolean favorites', async () => {
    await kb.setFavorite('wiki/a.md', true);
    expect(await kb.isFavorite('wiki/a.md')).toBe(true);
    expect(await kb.listFavorites()).toEqual([{ documentId: 'wiki/a.md', value: true }]);
  });

  it('persists object values and distinguishes multiple favorites', async () => {
    await kb.setFavorite('wiki/a.md', { note: 'starred', pinned: true });
    await kb.setFavorite('wiki/b.md', false);

    expect(await kb.isFavorite('wiki/a.md')).toBe(true);
    expect(await kb.isFavorite('wiki/b.md')).toBe(false);
    const favorites = await kb.listFavorites();
    expect(favorites).toHaveLength(1);
    expect(favorites[0]).toEqual({ documentId: 'wiki/a.md', value: { note: 'starred', pinned: true } });
  });

  it('removes a favorite when set to a falsy value', async () => {
    await kb.setFavorite('wiki/a.md', true);
    await kb.setFavorite('wiki/a.md', false);
    expect(await kb.isFavorite('wiki/a.md')).toBe(false);
    expect(await kb.listFavorites()).toEqual([]);
  });
});

describe('manifest round-trip', () => {
  it('round-trips a manifest with document and artifact entries', async () => {
    const manifest = makeManifest(REV_A, [
      DOC_ENTRY('wiki/a.md', HASH_1),
      DOC_ENTRY('outputs/report.md', HASH_2),
      ARTIFACT_ENTRY('outputs/app.apk', HASH_3),
    ]);
    await kb.commitRevision({
      revision: REV_A,
      manifest,
      contents: [
        { sha256: HASH_1, text: '# a' },
        { sha256: HASH_2, text: '# report' },
      ],
    });

    expect(await kb.getManifest(REV_A)).toEqual(manifest);
    expect(await kb.getActiveManifest()).toEqual(manifest);
    expect(await kb.getDocumentText(HASH_1)).toBe('# a');
    expect(await kb.getDocumentText(HASH_3)).toBeUndefined(); // artifact has no stored body
  });
});