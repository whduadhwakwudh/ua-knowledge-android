/**
 * Favorites store (Task 7) — thin wrapper over the cache-db favorites store.
 *
 * Records: documentId → { favoritedAt: ISO datetime }. The wrapper keeps the
 * cache-db contract ({documentId, value} records where value is a boolean or a
 * small object) untouched: adding a favorite stores {favoritedAt}, removing it
 * writes a falsy value, and listing normalizes legacy boolean records to
 * {documentId, favoritedAt: null}.
 */

export function createFavoritesStore(db) {
  /**
   * @returns {Promise<Array<{documentId: string, favoritedAt: string|null}>>}
   */
  async function list() {
    const records = await db.listFavorites();
    return records.map((record) => ({
      documentId: record.documentId,
      favoritedAt:
        record.value !== null &&
        typeof record.value === 'object' &&
        typeof record.value.favoritedAt === 'string'
          ? record.value.favoritedAt
          : null,
    }));
  }

  async function isFavorite(documentId) {
    return db.isFavorite(documentId);
  }

  /**
   * Flips the favorite state for a document. Resolves to the NEW state
   * (true = now favorite).
   */
  async function toggle(documentId) {
    const currently = await db.isFavorite(documentId);
    if (currently) {
      await db.setFavorite(documentId, false);
      return false;
    }
    await db.setFavorite(documentId, { favoritedAt: new Date().toISOString() });
    return true;
  }

  return { list, isFavorite, toggle };
}