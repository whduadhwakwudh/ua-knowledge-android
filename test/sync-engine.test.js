import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { createSyncEngine } from '../src/sync-engine.js';
import { openKnowledgeDb, DB_NAME } from '../src/cache-db.js';
import { ApiError } from '../src/api-client.js';

/**
 * Sync engine tests — a fake api (no network) driving the real cache-db over
 * fake-indexeddb. All manifest/document fixtures are built at runtime.
 */

const REV_1 = 'a'.repeat(64);
const REV_2 = 'b'.repeat(64);

/** Sentinel standing in for a device credential; phase events must never carry it. */
const SENTINEL = 'sentinel-device-token-7890-abcdef';

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic 43-char base64url entry id derived from the relative path. */
async function idFor(relativePath) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(relativePath));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function docEntry(relativePath, text, title = 'Doc ' + relativePath) {
  return {
    id: await idFor(relativePath),
    relativePath,
    kind: 'document',
    mime: 'text/markdown; charset=utf-8',
    size: new TextEncoder().encode(text).length,
    mtime: '2026-01-01T00:00:00Z',
    sha256: await sha256hex(text),
    title,
  };
}

async function artifactEntry(relativePath) {
  return {
    id: await idFor(relativePath),
    relativePath,
    kind: 'artifact',
    mime: 'application/vnd.android.package-archive',
    size: 4096,
    mtime: '2026-01-02T00:00:00Z',
    sha256: 'f'.repeat(64),
    title: 'Apk ' + relativePath,
  };
}

function makeManifest(revision, entries) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-02-01T00:00:00Z',
    revision,
    entries,
  };
}

/**
 * Fake api: serves a fixed manifest and fetched document bodies, recording every
 * call. The api object deliberately holds a sentinel credential on itself so
 * tests can prove phase events never include it. Manifest, documents and the
 * failure list are mutable FIELDS (read back through the object) so a test can
 * swap in a later revision mid-scenario.
 */
function createFakeApi({
  manifest,
  documents = new Map(),
  failDocuments = [],
  manifestImpl = null,
  transientManifestFailures = 0,
}) {
  const calls = { manifest: 0, documents: [] };
  let failuresLeft = transientManifestFailures;
  const api = {
    calls,
    token: SENTINEL,
    manifest,
    documents,
    failDocuments,
    async getManifest() {
      calls.manifest += 1;
      if (manifestImpl) return manifestImpl();
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new ApiError(ApiError.NETWORK, 'transient manifest failure');
      }
      return api.manifest;
    },
    async getDocument(id) {
      calls.documents.push(id);
      if (api.failDocuments.includes(id)) {
        throw new ApiError(ApiError.NETWORK, 'transient download failure');
      }
      const doc = api.documents.get(id);
      if (!doc) throw new ApiError(ApiError.NOT_FOUND, 'unknown document');
      return { text: doc.text, etag: doc.etag ?? null };
    },
  };
  return api;
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

function engine(api) {
  return createSyncEngine({ api, db: kb });
}

describe('first sync', () => {
  it('downloads every document, never artifacts, commits, and reports counts', async () => {
    const a = await docEntry('wiki/a.md', '# First body');
    const b = await docEntry('wiki/b.md', '# Second body');
    const apk = await artifactEntry('outputs/app.apk');
    const manifest = makeManifest(REV_1, [a, b, apk]);
    const api = createFakeApi({
      manifest,
      documents: new Map([
        [a.id, { text: '# First body' }],
        [b.id, { text: '# Second body' }],
      ]),
    });

    const result = await engine(api).sync();
    expect(result).toEqual({ added: 3, updated: 0, removed: 0, unchanged: 0, revision: REV_1 });

    // Both documents fetched by id — the artifact entry never triggers a fetch.
    expect(api.calls.documents).toEqual([a.id, b.id]);

    // Committed and readable.
    expect(await kb.getActiveRevision()).toBe(REV_1);
    const active = await kb.getActiveManifest();
    expect(active.entries).toHaveLength(3);
    expect(await kb.getDocumentText(a.sha256)).toBe('# First body');
    expect(await kb.getDocumentText(b.sha256)).toBe('# Second body');
    // Artifact metadata present, but no artifact body was ever stored.
    expect(await kb.getDocumentText(apk.sha256)).toBeUndefined();
  });
});

describe('no-change sync', () => {
  it('reports everything unchanged and performs no downloads', async () => {
    const a = await docEntry('wiki/a.md', '# First body');
    const b = await docEntry('wiki/b.md', '# Second body');
    const apk = await artifactEntry('outputs/app.apk');
    const manifest = makeManifest(REV_1, [a, b, apk]);
    const api = createFakeApi({
      manifest,
      documents: new Map([
        [a.id, { text: '# First body' }],
        [b.id, { text: '# Second body' }],
      ]),
    });

    await engine(api).sync();
    const firstFetchCount = api.calls.documents.length;

    const result = await engine(api).sync();
    expect(result).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 3, revision: REV_1 });
    expect(api.calls.documents).toHaveLength(firstFetchCount); // no new fetches
  });
});

describe('one update + one delete', () => {
  it('applies the diff and commits the new revision', async () => {
    const a1 = await docEntry('wiki/a.md', '# First body');
    const b = await docEntry('wiki/b.md', '# Second body');
    const apk = await artifactEntry('outputs/app.apk');
    const manifest1 = makeManifest(REV_1, [a1, b, apk]);
    const api = createFakeApi({
      manifest: manifest1,
      documents: new Map([
        [a1.id, { text: '# First body' }],
        [b.id, { text: '# Second body' }],
      ]),
    });
    await engine(api).sync();

    // Rev 2: A updated, B deleted, C added; artifact unchanged.
    const a2 = await docEntry('wiki/a.md', '# First body, revised');
    const c = await docEntry('wiki/c.md', '# Third body');
    const manifest2 = makeManifest(REV_2, [a2, c, apk]);
    api.manifest = manifest2;
    api.documents = new Map([
      [a2.id, { text: '# First body, revised' }],
      [c.id, { text: '# Third body' }],
    ]);
    const before = api.calls.documents.length;

    const result = await engine(api).sync();
    expect(result).toEqual({ added: 1, updated: 1, removed: 1, unchanged: 1, revision: REV_2 });

    // Only the updated and the added document are fetched — never the deleted
    // one and never the artifact.
    expect(api.calls.documents.slice(before)).toEqual([a2.id, c.id]);
    expect(api.calls.documents.slice(before)).not.toContain(b.id);

    expect(await kb.getActiveRevision()).toBe(REV_2);
    const active = await kb.getActiveManifest();
    expect(active.entries.map((e) => e.relativePath).sort()).toEqual([
      'outputs/app.apk',
      'wiki/a.md',
      'wiki/c.md',
    ]);
    expect(await kb.getDocumentText(a2.sha256)).toBe('# First body, revised');
    expect(await kb.getDocumentText(c.sha256)).toBe('# Third body');
  });
});

describe('failure handling', () => {
  it('an interrupted download aborts with no state change', async () => {
    const a1 = await docEntry('wiki/a.md', '# First body');
    const manifest1 = makeManifest(REV_1, [a1]);
    const api = createFakeApi({
      manifest: manifest1,
      documents: new Map([[a1.id, { text: '# First body' }]]),
    });
    await engine(api).sync();

    // Rev 2 updates A, but the download dies mid-way.
    const a2 = await docEntry('wiki/a.md', '# Revised body');
    const manifest2 = makeManifest(REV_2, [a2]);
    api.manifest = manifest2;
    api.failDocuments = [a2.id];

    const error = await engine(api).sync().then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(ApiError.NETWORK);

    // No commit: active revision and readable state are untouched.
    expect(await kb.getActiveRevision()).toBe(REV_1);
    expect(await kb.getManifest(REV_2)).toBeUndefined();
    expect(await kb.getDocumentText(a1.sha256)).toBe('# First body');
  });

  it('a sha256 mismatch rejects and writes nothing', async () => {
    const a1 = await docEntry('wiki/a.md', '# First body');
    const manifest1 = makeManifest(REV_1, [a1]);
    const api = createFakeApi({
      manifest: manifest1,
      documents: new Map([[a1.id, { text: '# First body' }]]),
    });
    await engine(api).sync();

    // Rev 2 claims the hash of "# Claimed body" but the server serves
    // "# Actual body" — the served bytes do not match the manifest entry.
    const a2 = await docEntry('wiki/a.md', '# Claimed body');
    const manifest2 = makeManifest(REV_2, [a2]);
    api.manifest = manifest2;
    api.documents = new Map([[a2.id, { text: '# Actual body' }]]);

    const error = await engine(api).sync().then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(ApiError.INTEGRITY);

    expect(await kb.getActiveRevision()).toBe(REV_1);
    expect(await kb.getManifest(REV_2)).toBeUndefined();
    // Neither the claimed-hash record nor any REV_2 content exists.
    expect(await kb.getDocumentText(a2.sha256)).toBeUndefined();
    expect(await kb.getDocumentText(a1.sha256)).toBe('# First body');
  });

  it('a 401 propagates with no state change', async () => {
    const a = await docEntry('wiki/a.md', '# First body');
    const manifest = makeManifest(REV_1, [a]);
    const api = createFakeApi({
      manifest,
      documents: new Map([[a.id, { text: '# First body' }]]),
      manifestImpl: async () => {
        throw new ApiError(ApiError.UNAUTHORIZED, 'unauthorized');
      },
    });

    const error = await engine(api).sync().then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(ApiError.UNAUTHORIZED);

    expect(await kb.getActiveRevision()).toBeNull();
    expect(await kb.getManifest(REV_1)).toBeUndefined();
    expect(api.calls.documents).toEqual([]);
  });

  it('a transient failure can be retried successfully', async () => {
    const a = await docEntry('wiki/a.md', '# First body');
    const manifest = makeManifest(REV_1, [a]);
    const api = createFakeApi({
      manifest,
      documents: new Map([[a.id, { text: '# First body' }]]),
      transientManifestFailures: 1,
    });

    const firstError = await engine(api).sync().then(
      () => null,
      (e) => e,
    );
    expect(firstError).toBeInstanceOf(ApiError);
    expect(firstError.code).toBe(ApiError.NETWORK);
    expect(await kb.getActiveRevision()).toBeNull();

    const result = await engine(api).sync();
    expect(result).toEqual({ added: 1, updated: 0, removed: 0, unchanged: 0, revision: REV_1 });
    expect(await kb.getActiveRevision()).toBe(REV_1);
    expect(await kb.getDocumentText(a.sha256)).toBe('# First body');
  });
});

describe('phase events', () => {
  it('reports the full phase sequence with counts and never credentials', async () => {
    const a = await docEntry('wiki/a.md', '# First body');
    const b = await docEntry('wiki/b.md', '# Second body');
    const apk = await artifactEntry('outputs/app.apk');
    const manifest = makeManifest(REV_1, [a, b, apk]);
    const api = createFakeApi({
      manifest,
      documents: new Map([
        [a.id, { text: '# First body' }],
        [b.id, { text: '# Second body' }],
      ]),
    });

    const events = [];
    const result = await engine(api).sync({ onPhase: (phase) => events.push(phase) });

    expect(events.map((e) => e.phase)).toEqual(['manifest', 'download', 'verify', 'commit', 'complete']);

    expect(events[0]).toMatchObject({ phase: 'manifest', revision: REV_1, total: 3 });
    expect(events[1]).toMatchObject({ phase: 'download', revision: REV_1, downloaded: 2 });
    expect(events[2]).toMatchObject({ phase: 'verify', revision: REV_1, verified: 2 });
    expect(events[3]).toMatchObject({ phase: 'commit', revision: REV_1 });
    expect(events[4]).toMatchObject({
      phase: 'complete',
      revision: REV_1,
      added: result.added,
      updated: result.updated,
      removed: result.removed,
      unchanged: result.unchanged,
    });

    // Phase events are plain, whitelisted payloads: no credential and no
    // foreign keys can ever leak in.
    const ALLOWED_KEYS = new Set(['phase', 'revision', 'total', 'downloaded', 'verified', 'added', 'updated', 'removed', 'unchanged']);
    for (const event of events) {
      for (const key of Object.keys(event)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    }
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
  });

  it('a no-change sync only emits manifest and complete', async () => {
    const a = await docEntry('wiki/a.md', '# First body');
    const manifest = makeManifest(REV_1, [a]);
    const api = createFakeApi({
      manifest,
      documents: new Map([[a.id, { text: '# First body' }]]),
    });
    await engine(api).sync();

    const events = [];
    await engine(api).sync({ onPhase: (phase) => events.push(phase) });
    expect(events.map((e) => e.phase)).toEqual(['manifest', 'complete']);
    expect(events[1]).toMatchObject({ phase: 'complete', revision: REV_1, added: 0, removed: 0, unchanged: 1 });
  });
});