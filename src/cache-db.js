/**
 * Knowledge cache — local IndexedDB persistence layer (Task 4).
 *
 * Stores:
 *   meta          key-value: 'activeRevision', 'previousRevision', 'lastSyncAt'
 *   manifests     keyPath 'revision' — one full manifest record per revision;
 *                 commits retain only the current + previous revisions (the
 *                 rollback window), so a corrupt or rejected sync can never
 *                 destroy the last good state.
 *   contents      keyPath 'sha256' — content-addressed markdown bodies.
 *   favorites     keyPath 'documentId' — {documentId, value} records where
 *                 value is a boolean or a small object.
 *   searchIndexes keyPath 'revision' — serialized MiniSearch JSON per revision
 *                 (written by the sync layer; the store exists here so the
 *                 schema is stable from v1).
 *   assistantMessages keyPath 'id' — chat history for the knowledge-base
 *                 assistant: {id, role: 'user'|'assistant', text, createdAt}.
 *
 * commitRevision writes the manifest, the new contents and meta.activeRevision
 * in ONE transaction: any thrown write aborts the whole transaction and the
 * previously active revision remains fully readable. gcUnreferenced() only
 * collects content hashes that are referenced by neither the current nor the
 * previous manifest and is meant to run only after a successful commit.
 */

import { openDB } from 'idb';

export const DB_NAME = 'ua-knowledge';
export const DB_VERSION = 2;

const META_ACTIVE_REVISION = 'activeRevision';
const META_PREVIOUS_REVISION = 'previousRevision';
const META_LAST_SYNC_AT = 'lastSyncAt';

/** 对话历史保留上限：超出时删除最旧的消息。 */
export const MAX_ASSISTANT_MESSAGES = 200;

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore('meta');
    db.createObjectStore('manifests', { keyPath: 'revision' });
    db.createObjectStore('contents', { keyPath: 'sha256' });
    db.createObjectStore('favorites', { keyPath: 'documentId' });
    db.createObjectStore('searchIndexes', { keyPath: 'revision' });
  }
  if (oldVersion < 2) {
    db.createObjectStore('assistantMessages', { keyPath: 'id' });
  }
}

/**
 * Opens (creating if needed) the knowledge cache and returns the storage API.
 * The returned object also exposes the raw idb database handle as `db` for
 * schema introspection and low-level store access.
 */
export async function openKnowledgeDb() {
  const db = await openDB(DB_NAME, DB_VERSION, { upgrade });

  async function getActiveRevision() {
    const value = await db.transaction('meta').objectStore('meta').get(META_ACTIVE_REVISION);
    return typeof value === 'string' ? value : null;
  }

  /**
   * Atomically becomes the new active revision: writes the manifest, the
   * content blobs and the meta pointers in one readwrite transaction. A
   * failure anywhere aborts the transaction, leaving the previous active
   * revision fully readable. Also prunes outdated manifests down to the
   * current + previous rollback window.
   */
  async function commitRevision({ revision, manifest, contents }) {
    // Internal invariant (content-addressing is self-enforcing): every
    // content blob passed in must be referenced by the manifest being
    // committed — a hash that matches no document entry is an orphan write
    // and rejected. The reverse is NOT required: document bodies may already
    // be cached from an earlier revision (content-addressed reuse), so a
    // commit may carry only the newly added/changed contents.
    const documentHashes = new Set(
      (manifest.entries ?? []).filter((e) => e.kind === 'document').map((e) => e.sha256),
    );
    for (const { sha256 } of contents) {
      if (typeof sha256 !== 'string' || !documentHashes.has(sha256)) {
        throw new TypeError('commitRevision: content key must match a manifest document entry');
      }
    }

    const tx = db.transaction(['meta', 'manifests', 'contents'], 'readwrite');
    const metaStore = tx.objectStore('meta');
    const manifestsStore = tx.objectStore('manifests');
    const contentsStore = tx.objectStore('contents');

    const previousRevision = (await metaStore.get(META_ACTIVE_REVISION)) ?? null;

    await manifestsStore.put(manifest);
    for (const { sha256, text } of contents) {
      await contentsStore.put({ sha256, text });
    }
    if (previousRevision === null) {
      await metaStore.delete(META_PREVIOUS_REVISION);
    } else {
      await metaStore.put(previousRevision, META_PREVIOUS_REVISION);
    }
    await metaStore.put(revision, META_ACTIVE_REVISION);
    await metaStore.put(new Date().toISOString(), META_LAST_SYNC_AT);

    // Rollback window: only the brand-new and the previous revision remain.
    const retained = new Set([revision, previousRevision].filter(Boolean));
    const allKeys = await manifestsStore.getAllKeys();
    for (const key of allKeys) {
      if (!retained.has(key)) await manifestsStore.delete(key);
    }

    await tx.done;
  }

  /**
   * Writes manifest + contents WITHOUT touching meta.activeRevision. This is
   * an optional building block; the sync engine currently commits atomically
   * via commitRevision and does NOT resume from staged state (an interrupted
   * sync re-fetches the manifest and changed documents next run). Kept for
   * callers that want a two-phase write.
   */
  async function stageManifest({ revision, manifest, contents }) {
    const tx = db.transaction(['manifests', 'contents'], 'readwrite');
    const manifestsStore = tx.objectStore('manifests');
    const contentsStore = tx.objectStore('contents');
    await manifestsStore.put(manifest);
    for (const { sha256, text } of contents) {
      await contentsStore.put({ sha256, text });
    }
    await tx.done;
  }

  /**
   * Deletes content blobs whose hash is referenced by neither the current
   * nor the previous manifest. Intended to run only after a successful
   * commit; a no-op when no revision is active.
   */
  async function gcUnreferenced() {
    const tx = db.transaction(['meta', 'manifests', 'contents'], 'readwrite');
    const metaStore = tx.objectStore('meta');
    const manifestsStore = tx.objectStore('manifests');
    const contentsStore = tx.objectStore('contents');

    const activeRevision = (await metaStore.get(META_ACTIVE_REVISION)) ?? null;
    if (activeRevision === null) {
      await tx.done;
      return;
    }
    const previousRevision = (await metaStore.get(META_PREVIOUS_REVISION)) ?? null;

    const referenced = new Set();
    for (const rev of [activeRevision, previousRevision]) {
      if (!rev) continue;
      const manifest = await manifestsStore.get(rev);
      if (manifest && Array.isArray(manifest.entries)) {
        for (const entry of manifest.entries) {
          if (entry && typeof entry.sha256 === 'string') referenced.add(entry.sha256);
        }
      }
    }

    const keys = await contentsStore.getAllKeys();
    for (const key of keys) {
      if (!referenced.has(key)) await contentsStore.delete(key);
    }
    await tx.done;
  }

  async function getDocumentText(sha256) {
    const record = await db.transaction('contents').objectStore('contents').get(sha256);
    return record ? record.text : undefined;
  }

  async function getManifest(revision) {
    const manifest = await db.transaction('manifests').objectStore('manifests').get(revision);
    return manifest ?? undefined;
  }

  async function getActiveManifest() {
    const revision = await getActiveRevision();
    if (revision === null) return undefined;
    return getManifest(revision);
  }

  async function listFavorites() {
    return db.transaction('favorites').objectStore('favorites').getAll();
  }

  async function isFavorite(documentId) {
    const record = await db.transaction('favorites').objectStore('favorites').get(documentId);
    return record !== undefined;
  }

  async function setFavorite(documentId, value) {
    const tx = db.transaction('favorites', 'readwrite');
    const store = tx.objectStore('favorites');
    if (value) {
      await store.put({ documentId, value });
    } else {
      await store.delete(documentId);
    }
    await tx.done;
  }

  /* ─── assistant chat history ────────────────────────────── */

  /** All assistant messages, oldest first. */
  async function listAssistantMessages() {
    const all = await db.transaction('assistantMessages').objectStore('assistantMessages').getAll();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /**
   * Append one assistant message (role 'user' | 'assistant') and prune to the
   * newest MAX_ASSISTANT_MESSAGES entries. Invalid records fail closed.
   */
  async function addAssistantMessage({ role, text, createdAt }) {
    if (role !== 'user' && role !== 'assistant') {
      throw new TypeError('assistant message role must be user or assistant');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('assistant message text must be a non-empty string');
    }
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const record = { id, role, text, createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString() };
    const tx = db.transaction('assistantMessages', 'readwrite');
    const store = tx.objectStore('assistantMessages');
    await store.put(record);
    const all = await store.getAll();
    if (all.length > MAX_ASSISTANT_MESSAGES) {
      const excess = all
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .slice(0, all.length - MAX_ASSISTANT_MESSAGES);
      for (const old of excess) await store.delete(old.id);
    }
    await tx.done;
    return record;
  }

  /** 清空全部助手对话历史。 */
  async function clearAssistantMessages() {
    const tx = db.transaction('assistantMessages', 'readwrite');
    await tx.objectStore('assistantMessages').clear();
    await tx.done;
  }

  return {
    db,
    getActiveRevision,
    commitRevision,
    stageManifest,
    gcUnreferenced,
    getDocumentText,
    getManifest,
    getActiveManifest,
    listFavorites,
    isFavorite,
    setFavorite,
    listAssistantMessages,
    addAssistantMessage,
    clearAssistantMessages,
  };
}