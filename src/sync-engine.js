/**
 * Sync engine (Task 5).
 *
 * Pulls the latest manifest from the API, diffs it against the locally active
 * revision, downloads only the new/changed DOCUMENT bodies (artifact entries
 * are metadata-only and never fetched), verifies each body's SHA-256 against
 * the manifest, then stages + atomically commits the new revision and garbage
 * collects unreferenced content.
 *
 * Failure rules (all leave the previous active revision fully readable):
 * - manifest/download errors propagate untouched (e.g. ApiError UNAUTHORIZED,
 *   NETWORK, RATE_LIMITED);
 * - a downloaded body whose hash differs from the manifest entry raises
 *   ApiError(INTEGRITY) and nothing is written;
 * - a 304 for an entry we expected to change is a server contract violation
 *   and also raises ApiError(INTEGRITY).
 *
 * Phase events (via the optional onPhase callback) carry only whitelisted
 * fields — phase name, revision and counts — never credentials or content.
 */

import { ApiError } from './api-client.js';

async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ApiError(ApiError.INTEGRITY, 'crypto.subtle is unavailable');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createSyncEngine({ api, db }) {
  async function sync({ onPhase } = {}) {
    const report = (event) => {
      if (typeof onPhase === 'function') onPhase(event);
      return event;
    };

    // ---- phase: manifest -------------------------------------------------
    const manifest = await api.getManifest();
    const revision = manifest.revision;
    report({ phase: 'manifest', revision, total: manifest.entries.length });

    // ---- diff against the active revision --------------------------------
    const activeManifest = await db.getActiveManifest();
    const oldByPath = new Map((activeManifest?.entries ?? []).map((entry) => [entry.relativePath, entry]));
    const newByPath = new Map(manifest.entries.map((entry) => [entry.relativePath, entry]));

    let added = 0;
    let updated = 0;
    let removed = 0;
    const toFetch = [];
    for (const entry of manifest.entries) {
      const previous = oldByPath.get(entry.relativePath);
      if (previous === undefined) {
        added += 1;
        if (entry.kind === 'document') toFetch.push(entry);
      } else if (previous.sha256 !== entry.sha256) {
        updated += 1;
        if (entry.kind === 'document') toFetch.push(entry);
      }
    }
    if (activeManifest !== undefined) {
      for (const path of oldByPath.keys()) {
        if (!newByPath.has(path)) removed += 1;
      }
    }
    const unchanged = manifest.entries.length - added - updated;

    // Nothing changed: report complete without touching the database.
    if (added === 0 && updated === 0 && removed === 0) {
      report({ phase: 'complete', revision, added, updated, removed, unchanged });
      return { added, updated, removed, unchanged, revision };
    }

    // ---- phase: download (documents only; artifacts are metadata-only) ----
    report({ phase: 'download', revision, downloaded: toFetch.length });
    const contents = [];
    for (const entry of toFetch) {
      // No etag is persisted, so every changed/new document is a full fetch.
      // A 304 (null) for an entry we expected to change violates the contract:
      // fail safe, keeping the previous active revision.
      const fetched = await api.getDocument(entry.id);
      if (fetched === null) {
        throw new ApiError(ApiError.INTEGRITY, 'document unexpectedly not modified');
      }
      contents.push({ sha256: entry.sha256, text: fetched.text });
    }

    // ---- phase: verify ----------------------------------------------------
    report({ phase: 'verify', revision, verified: contents.length });
    for (const { sha256, text } of contents) {
      const actual = await sha256Hex(text);
      if (actual !== sha256) {
        throw new ApiError(ApiError.INTEGRITY, 'document content hash mismatch');
      }
    }

    // ---- phase: commit ----------------------------------------------------
    report({ phase: 'commit', revision });
    await db.stageManifest({ revision, manifest, contents });
    await db.commitRevision({ revision, manifest, contents });
    await db.gcUnreferenced();

    // ---- phase: complete --------------------------------------------------
    report({ phase: 'complete', revision, added, updated, removed, unchanged });
    return { added, updated, removed, unchanged, revision };
  }

  return { sync };
}