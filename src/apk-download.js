/**
 * APK download + verify (Task 8).
 *
 * downloadAndVerifyApk() brings a manifest artifact entry onto the device:
 *   1. destination path — downloads/<sanitized title>-<sha256[:12]>.apk under
 *      the app-private Filesystem Directory.Data (no external storage, so no
 *      storage permission is required);
 *   2. URI via Filesystem.getUri → FileTransfer.downloadFile with the device
 *      token as an Authorization Bearer header (+ optional progress);
 *   3. SHA-256 of the downloaded bytes via the local UaFileHash plugin;
 *   4. exact lowercase hex match against the manifest entry; on mismatch the
 *      file is deleted and the promise rejects (HASH_MISMATCH);
 *   5. only after a match is the file handed to @capacitor-community/file-opener,
 *      which raises the system installer confirmation. This module never
 *      requests a silent install or any elevated install API.
 *
 * Every plugin call is a named injectable (getUriImpl / downloadImpl /
 * nativeHashImpl / openImpl / deleteImpl) so the whole flow is unit-testable
 * with mocks and no network or filesystem access. Setting downloadImpl to null
 * selects a web fallback that downloads through fetchImpl and hashes with
 * crypto.subtle (no filesystem, no opener) — used only by callers that opt in.
 */

import { Directory, Filesystem } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { FileOpener } from '@capacitor-community/file-opener';

export const ARTIFACT_MIME = 'application/vnd.android.package-archive';
const HASH_PREFIX_LENGTH = 12;

/**
 * Keeps Unicode letters/numbers plus `._-`; every other run collapses to `_`.
 * Never returns an empty string.
 */
export function sanitizeFilename(value) {
  const cleaned = String(value ?? '').replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return cleaned === '' ? '_' : cleaned;
}

export class ApkDownloadError extends Error {
  static HASH_MISMATCH = 'HASH_MISMATCH';
  static HTTP = 'HTTP';
  static NETWORK = 'NETWORK';
  static IO = 'IO';

  constructor(code, message) {
    super(message);
    this.name = 'ApkDownloadError';
    this.code = code;
  }
}

function artifactUrl(apiBaseUrl, id) {
  return String(apiBaseUrl).replace(/\/+$/, '') + '/v1/artifacts/' + encodeURIComponent(id);
}

async function subtleSha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function defaultGetUri({ directory, path }) {
  return Filesystem.getUri({ directory, path });
}

async function defaultDownload({ url, path, headers, onProgress }) {
  let listener = null;
  if (typeof onProgress === 'function') {
    listener = await FileTransfer.addListener('progress', (info) => {
      onProgress({
        percent: info.percent,
        bytesSent: info.bytesSent ?? 0,
        totalBytes: info.totalBytes ?? 0,
      });
    });
  }
  try {
    return await FileTransfer.downloadFile({
      url,
      path,
      headers,
      ...(typeof onProgress === 'function' ? { progress: true } : {}),
    });
  } finally {
    if (listener && typeof listener.remove === 'function') {
      try {
        await listener.remove();
      } catch {
        // Listener cleanup is best-effort.
      }
    }
  }
}

/**
 * Native SHA-256 via the locally registered UaFileHash plugin. The plugin
 * never logs the path or the content; it returns lowercase hex.
 */
async function defaultNativeHash({ path }) {
  const { Capacitor } = await import('@capacitor/core');
  const plugin = Capacitor.Plugins && Capacitor.Plugins.UaFileHash;
  if (!plugin || typeof plugin.hashFile !== 'function') {
    throw new ApkDownloadError(ApkDownloadError.IO, 'native hash plugin unavailable');
  }
  const result = await plugin.hashFile({ path });
  return { sha256: typeof result?.sha256 === 'string' ? result.sha256 : '' };
}

async function defaultOpen(options) {
  // openWithDefault triggers the ACTION_VIEW system flow (package installer
  // confirmation). No silent-install API is ever used.
  await FileOpener.open(options);
}

async function defaultDelete({ directory, path }) {
  await Filesystem.deleteFile({ directory, path });
}

export async function downloadAndVerifyApk({
  entry,
  apiBaseUrl,
  token,
  fetchImpl = null,
  nativeHashImpl = defaultNativeHash,
  getUriImpl = defaultGetUri,
  downloadImpl = defaultDownload,
  openImpl = defaultOpen,
  deleteImpl = defaultDelete,
  onProgress = null,
}) {
  const expected = String(entry.sha256 ?? '').toLowerCase();
  const fileName = `${sanitizeFilename(entry.title)}-${expected.slice(0, HASH_PREFIX_LENGTH)}.apk`;
  const relativePath = `downloads/${fileName}`;
  const url = artifactUrl(apiBaseUrl, entry.id);
  const authHeaders = { Authorization: `Bearer ${token}` };

  /* ── web fallback (opt-in via downloadImpl: null): fetch + subtle hash ── */
  if (downloadImpl === null) {
    const fetcher = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    if (typeof fetcher !== 'function') {
      throw new ApkDownloadError(ApkDownloadError.NETWORK, 'no download transport available');
    }
    let res;
    try {
      res = await fetcher(url, { method: 'GET', headers: authHeaders });
    } catch {
      throw new ApkDownloadError(ApkDownloadError.NETWORK, 'download failed');
    }
    if (!res || !res.ok) {
      throw new ApkDownloadError(ApkDownloadError.HTTP, `download failed (HTTP ${res?.status ?? 'unknown'})`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = await subtleSha256(bytes);
    if (actual !== expected) {
      throw new ApkDownloadError(ApkDownloadError.HASH_MISMATCH, 'apk content hash mismatch');
    }
    // No on-device file exists on the web: nothing to delete or open.
    return { sha256: actual, blob: bytes, fileName };
  }

  /* ── native path: getUri → transfer → native hash → open ────────────── */
  const target = await getUriImpl({ directory: Directory.Data, path: relativePath });
  const uri = typeof target === 'string' ? target : target?.uri;

  const transfer = await downloadImpl({ url, path: uri, headers: authHeaders, onProgress });
  const finalUri = typeof transfer === 'string' ? transfer : transfer?.path ?? uri;

  const hashed = await nativeHashImpl({ path: finalUri });
  const actual = String(hashed?.sha256 ?? '').toLowerCase();
  if (actual !== expected) {
    try {
      await deleteImpl({ directory: Directory.Data, path: relativePath });
    } catch {
      // Best-effort cleanup; the mismatch rejection must still surface.
    }
    throw new ApkDownloadError(ApkDownloadError.HASH_MISMATCH, 'apk content hash mismatch');
  }

  await openImpl({ filePath: finalUri, contentType: ARTIFACT_MIME, openWithDefault: true });
  return { uri: finalUri, sha256: actual, fileName };
}