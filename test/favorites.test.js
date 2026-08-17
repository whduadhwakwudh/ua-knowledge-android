import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { openKnowledgeDb, DB_NAME } from '../src/cache-db.js';
import { createFavoritesStore } from '../src/favorites.js';

/**
 * Favorites store tests — the thin wrapper over cache-db favorites must run
 * against the REAL cache database over fake-indexeddb (documentId →
 * {favoritedAt}). Every test starts from a freshly deleted database.
 */

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
  if (kb) kb.db.close();
  await deleteDatabase(DB_NAME);
  kb = await openKnowledgeDb();
});

afterAll(() => {
  kb?.db.close();
});

describe('createFavoritesStore — thin cache-db favorites wrapper', () => {
  it('starts with no favorites', async () => {
    const store = createFavoritesStore(kb);
    expect(await store.list()).toEqual([]);
    expect(await store.isFavorite('wiki/a.md')).toBe(false);
  });

  it('toggle() adds a favorite carrying an ISO favoritedAt', async () => {
    const store = createFavoritesStore(kb);
    expect(await store.toggle('wiki/a.md')).toBe(true);

    const favorites = await store.list();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].documentId).toBe('wiki/a.md');
    expect(typeof favorites[0].favoritedAt).toBe('string');
    expect(Number.isNaN(Date.parse(favorites[0].favoritedAt))).toBe(false);
    expect(await store.isFavorite('wiki/a.md')).toBe(true);
  });

  it('toggle() again removes the favorite and reports false', async () => {
    const store = createFavoritesStore(kb);
    await store.toggle('wiki/a.md');
    expect(await store.toggle('wiki/a.md')).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.isFavorite('wiki/a.md')).toBe(false);
  });

  it('keeps multiple favorites independent', async () => {
    const store = createFavoritesStore(kb);
    await store.toggle('wiki/a.md');
    await store.toggle('wiki/b.md');
    const favorites = await store.list();
    expect(favorites.map((f) => f.documentId).sort()).toEqual(['wiki/a.md', 'wiki/b.md']);
    expect(await store.isFavorite('wiki/a.md')).toBe(true);
    expect(await store.isFavorite('wiki/b.md')).toBe(true);
  });

  it('normalizes legacy boolean records written directly through cache-db', async () => {
    const store = createFavoritesStore(kb);
    await kb.setFavorite('wiki/legacy.md', true);
    const favorites = await store.list();
    expect(favorites).toEqual([{ documentId: 'wiki/legacy.md', favoritedAt: null }]);
    expect(await store.isFavorite('wiki/legacy.md')).toBe(true);
    // Toggling a legacy boolean favorite removes it.
    expect(await store.toggle('wiki/legacy.md')).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('persists favorites across separate database handle opens', async () => {
    const first = createFavoritesStore(kb);
    await first.toggle('wiki/persisted.md');
    expect(await first.isFavorite('wiki/persisted.md')).toBe(true);

    const kb2 = await openKnowledgeDb();
    const second = createFavoritesStore(kb2);
    const favorites = await second.list();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].documentId).toBe('wiki/persisted.md');
    expect(await second.isFavorite('wiki/persisted.md')).toBe(true);
  });
});