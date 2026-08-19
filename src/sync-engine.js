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
  // Single-flight guard: overlapping sync() calls share one in-flight
  // promise. Without it two concurrent runs could commit out of order,
  // inverting the previous/active rollback window, transiently rolling the
  // active snapshot backward, duplicating downloads and interleaving phase
  // events. A caller that arrives while a sync is running receives the SAME
  // promise (its onPhase callback is ignored for the shared run); a new sync
  // after the first settles starts fresh.
  let inFlight = null;

  async function sync({ onPhase } = {}) {
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = runSync(onPhase);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function runSync(onPhase) {
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
    // 逐篇上报 downloaded 计数，让 UI 进度条随下载逐步推进。
    report({ phase: 'download', revision, downloaded: 0 });
    const contents = [];
    for (let i = 0; i < toFetch.length; i += 1) {
      // No etag is persisted, so every changed/new document is a full fetch.
      // A 304 (null) for an entry we expected to change violates the contract:
      // fail safe, keeping the previous active revision.
      const fetched = await api.getDocument(toFetch[i].id);
      if (fetched === null) {
        throw new ApiError(ApiError.INTEGRITY, 'document unexpectedly not modified');
      }
      contents.push({ sha256: toFetch[i].sha256, text: fetched.text });
      report({ phase: 'download', revision, downloaded: i + 1 });
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
    // One atomic write: manifest + contents + meta.activeRevision in a single
    // transaction. There is no staged state to resume from — an interrupted
    // sync simply re-fetches the manifest and changed documents next time.
    await db.commitRevision({ revision, manifest, contents });
    await db.gcUnreferenced();

    // ---- phase: complete --------------------------------------------------
    report({ phase: 'complete', revision, added, updated, removed, unchanged });
    return { added, updated, removed, unchanged, revision };
  }

  return { sync };
}