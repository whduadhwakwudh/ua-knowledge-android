/**
 * Authenticated client for the knowledge-base sync API (Batch 3).
 *
 * Security invariants:
 * - The device token is only ever placed in the Authorization request header
 *   (or the ApiError-carrying caller's memory) — never in URLs, error
 *   messages, or serialized error data.
 * - Response bodies are never read for error statuses, and thrown errors
 *   carry only stable codes plus generic messages.
 * - No automatic retries in this batch.
 * - Response bodies are size-bounded: the manifest and document bodies are
 *   capped (content-length pre-check before reading, UTF-8 byte count after
 *   reading) so a hostile or broken server cannot make us buffer unbounded
 *   data. See MANIFEST_MAX_BYTES / markdownMaxBytes.
 * - HTTP status mapping: 401 → UNAUTHORIZED, 404 → NOT_FOUND, 429 →
 *   RATE_LIMITED, any other 4xx → REQUEST, ≥500 → SERVER.
 */

import { normalizeBaseUrl, validateToken } from './connection-store.js';

export const DEFAULT_MARKDOWN_MAX_BYTES = 5_242_880; // 5 MiB
/** Manifest response cap — 5 MiB, matching the server's markdown cap. */
export const MANIFEST_MAX_BYTES = 5_242_880; // 5 MiB
/**
 * Default per-request timeout. A hung connection (no response, black-hole
 * route, slow server) must never wedge a sync forever: the client aborts the
 * fetch and raises ApiError(NETWORK) so the UI can surface the failure and
 * allow a retry.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  static NETWORK = 'NETWORK';
  static UNAUTHORIZED = 'UNAUTHORIZED';
  static RATE_LIMITED = 'RATE_LIMITED';
  static SERVER = 'SERVER';
  static SCHEMA = 'SCHEMA';
  static INTEGRITY = 'INTEGRITY';
  static NOT_FOUND = 'NOT_FOUND';
  /** Client-visible request rejection (other 4xx that is not a mapped case). */
  static REQUEST = 'REQUEST';
  /** 智能助手未配置（服务端 503，无 LLM key）。 */
  static ASSISTANT_UNAVAILABLE = 'ASSISTANT_UNAVAILABLE';
  /** 智能助手上游超时（服务端 504）。 */
  static ASSISTANT_TIMEOUT = 'ASSISTANT_TIMEOUT';

  constructor(code, message, { status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || value === '') return null;
  const seconds = Number(value);
  if (Number.isSafeInteger(seconds) && seconds >= 0) return seconds;
  return null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Manifest contract (mirrors the server's Zod schema in
 * ua-knowledge-sync/src/manifest.ts):
 *
 *   Manifest = { schemaVersion: 1, generatedAt: ISO datetime,
 *                revision: lowercase 64 hex, entries: ManifestEntry[] }
 *   ManifestEntry = { id: 43-char base64url,
 *                     relativePath: allowlisted normalized path,
 *                     kind: 'document' | 'artifact',
 *                     mime: exact kind/extension mime,
 *                     size: non-negative integer,
 *                     mtime: ISO datetime string,
 *                     sha256: lowercase 64 hex,
 *                     title: non-empty string }
 *
 * All failures raise a stable ApiError(SCHEMA) with a generic message.
 */

/** Entry id: full base64url SHA-256 of the normalized relative path (43 chars). */
const ENTRY_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** sha256 / top-level revision: lowercase 64 hex. */
const LOWERCASE_HEX_64 = /^[a-f0-9]{64}$/;
/** ISO 8601 datetime with seconds, optional fraction, and a Z or numeric offset. */
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Days in a 1-based month; safe against Date.UTC treating years 0–99 as 1900–1999. */
function daysInMonth(year, month) {
  // Leap years repeat every 400 years, so shifting into 400–799 keeps the
  // leap rule identical while avoiding Date.UTC's 0–99 year quirk.
  const safeYear = (year % 400) + 400;
  return new Date(Date.UTC(safeYear, month, 0)).getUTCDate();
}

/**
 * Server allowlist mirror (manifest.ts RULES + path-policy.ts): the path
 * prefix `wiki/`, `outputs/` or `raw/` must match case-sensitively (the
 * server uses startsWith on the exact prefix), while the file extension
 * matches case-insensitively (the server lowercases the extension). This
 * mirrors the server exactly, so a hostile server emitting `WIKI/x.md` is
 * rejected here just as the real server would never emit it.
 */
const ALLOWLISTED_PATH_PATTERNS = [
  /^wiki\/.+\.md$/i,
  /^outputs\/.+\.md$/i,
  /^outputs\/.+\.apk$/i,
  /^raw\/.+\.md$/i,
];

function isAllowlistedPath(p) {
  if (!/^(wiki|outputs|raw)\//.test(p)) return false;
  return ALLOWLISTED_PATH_PATTERNS.some((re) => re.test(p));
}

const KIND_FOR_EXTENSION = { md: 'document', apk: 'artifact' };
const MIME_FOR_KIND = {
  document: 'text/markdown; charset=utf-8',
  artifact: 'application/vnd.android.package-archive',
};

function isValidIsoDatetime(value) {
  if (typeof value !== 'string') return false;
  const m = ISO_DATETIME_RE.exec(value);
  if (!m) return false;
  const [, year, month, day, hour, minute, second] = m;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  // Validate the calendar date in the literal's own frame. Date.parse alone is
  // not enough: it silently rolls over invalid dates (e.g. '2026-02-30' becomes
  // March 2), and comparing against UTC components would reject valid datetimes
  // whose offset crosses midnight or a month boundary.
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(y, mo)) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  // Rejects out-of-range offsets ('+99:99') and leap seconds (':60').
  return Number.isFinite(Date.parse(value));
}

/**
 * Validates a normalized manifest relativePath: no empty/dot/hidden/_tmp/
 * node_modules segments (the latter two case-insensitively), no leading
 * slash/backslash, and an exact mirror of the server allowlist — the `wiki/`
 * / `outputs/` prefix is case-sensitive, the extension is not. The original
 * path casing is preserved.
 */
function isValidRelativePath(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  const segments = p.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    if (segment.startsWith('.')) return false;
    const lower = segment.toLowerCase();
    if (lower.startsWith('_tmp') || lower === 'node_modules') return false;
  }
  return isAllowlistedPath(p);
}

/** Expected kind derived from the relativePath extension, or null. */
function expectedKindForPath(p) {
  const dot = p.lastIndexOf('.');
  if (dot <= 0) return null;
  return KIND_FOR_EXTENSION[p.slice(dot + 1).toLowerCase()] ?? null;
}

function isValidEntryShape(entry) {
  if (!isObject(entry)) return false;
  if (typeof entry.id !== 'string' || !ENTRY_ID_RE.test(entry.id)) return false;
  if (!isValidRelativePath(entry.relativePath)) return false;
  const expectedKind = expectedKindForPath(entry.relativePath);
  if (entry.kind !== expectedKind) return false;
  if (entry.mime !== MIME_FOR_KIND[entry.kind]) return false;
  if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) {
    return false;
  }
  if (!isValidIsoDatetime(entry.mtime)) return false;
  if (typeof entry.sha256 !== 'string' || !LOWERCASE_HEX_64.test(entry.sha256)) return false;
  if (typeof entry.title !== 'string' || entry.title.trim() === '') return false;
  return true;
}

function validateManifest(body) {
  if (!isObject(body)) {
    throw new ApiError(ApiError.SCHEMA, 'invalid manifest payload');
  }
  if (body.schemaVersion !== 1) {
    throw new ApiError(ApiError.SCHEMA, 'unsupported manifest schema version');
  }
  if (!isValidIsoDatetime(body.generatedAt)) {
    throw new ApiError(ApiError.SCHEMA, 'invalid manifest generatedAt');
  }
  if (typeof body.revision !== 'string' || !LOWERCASE_HEX_64.test(body.revision)) {
    throw new ApiError(ApiError.SCHEMA, 'invalid manifest revision');
  }
  if (!Array.isArray(body.entries)) {
    throw new ApiError(ApiError.SCHEMA, 'invalid manifest entries');
  }
  for (const entry of body.entries) {
    if (!isValidEntryShape(entry)) {
      throw new ApiError(ApiError.SCHEMA, 'invalid manifest entry');
    }
  }
  return {
    schemaVersion: body.schemaVersion,
    generatedAt: body.generatedAt,
    revision: body.revision,
    entries: body.entries,
  };
}

export function createApiClient({
  baseUrl,
  token,
  fetchImpl = fetch,
  markdownMaxBytes = DEFAULT_MARKDOWN_MAX_BYTES,
  manifestMaxBytes = MANIFEST_MAX_BYTES,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  // Fail fast at construction with generic TypeError messages (never echo the
  // candidate values). Reuses the connection-store validation so the client
  // and the settings UI agree on what a valid base URL / device token is.
  // connection-store.js imports nothing from this module, so this import is
  // cycle-free.
  const urlResult = normalizeBaseUrl(baseUrl);
  if (!urlResult.ok) {
    throw new TypeError(urlResult.error);
  }
  const tokenResult = validateToken(token);
  if (!tokenResult.ok) {
    throw new TypeError(tokenResult.error);
  }
  const origin = urlResult.value;

  const authHeaders = () => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
  const anonymousHeaders = () => ({ Accept: 'application/json' });

  function throwForStatus(res) {
    const status = res.status;
    if (status === 401) {
      throw new ApiError(ApiError.UNAUTHORIZED, 'unauthorized', { status });
    }
    if (status === 404) {
      throw new ApiError(ApiError.NOT_FOUND, 'not found', { status });
    }
    if (status === 429) {
      const retryAfterSeconds =
        res.headers && typeof res.headers.get === 'function'
          ? parseRetryAfter(res.headers.get('retry-after'))
          : null;
      throw new ApiError(ApiError.RATE_LIMITED, 'rate limited', { status, retryAfterSeconds });
    }
    if (status >= 500) {
      throw new ApiError(ApiError.SERVER, 'server error', { status });
    }
    // Any other 4xx (403, 405, 422, …) is a hard client-side rejection that
    // is not worth retrying; NOT_FOUND keeps its own stable code above.
    if (status >= 400 && status < 500) {
      throw new ApiError(ApiError.REQUEST, 'request rejected', { status });
    }
    if (status < 200 || status >= 300) {
      throw new ApiError(ApiError.SERVER, 'unexpected response', { status });
    }
  }

  async function request(pathname, { method = 'GET', headers, body, allowedStatuses = [] } = {}) {
    let res;
    // Timeout guard: a request that neither completes nor errors (black-hole
    // route, stalled server) must not hold `sync()` in the download phase
    // forever. AbortController covers real fetch; Promise.race guarantees the
    // timeout fires even when an injected fetchImpl ignores `signal`.
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(new ApiError(ApiError.NETWORK, 'network request timed out'));
      }, timeoutMs);
    });
    try {
      res = await Promise.race([
        fetchImpl(origin + pathname, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        }),
        timeout,
      ]);
    } catch (err) {
      // Timeout (NETWORK) and any transport failure both map to NETWORK; never
      // leak the underlying error (it may carry a URL or credentials).
      if (err instanceof ApiError) throw err;
      throw new ApiError(ApiError.NETWORK, 'network request failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 304) return res;
    // Callers may opt out of the standard status mapping for a specific set
    // of statuses they handle themselves (e.g. /v1/ask 503/504).
    if (allowedStatuses.includes(res.status)) return res;
    throwForStatus(res);
    return res;
  }

  async function health() {
    const res = await request('/v1/health', { headers: anonymousHeaders() });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new ApiError(ApiError.SCHEMA, 'invalid health response');
    }
    if (!isObject(body) || body.ok !== true) {
      throw new ApiError(ApiError.SCHEMA, 'invalid health response');
    }
    return { ok: true };
  }

  async function getManifest() {
    const res = await request('/v1/manifest', { headers: authHeaders() });

    // Mirror the getDocument() cap pattern: reject on the declared
    // content-length before reading, then enforce the real UTF-8 byte count
    // after reading, so a hostile or broken server cannot make us buffer an
    // unbounded body or JSON.parse one.
    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader !== null && contentLengthHeader !== '') {
      const declared = Number(contentLengthHeader);
      if (Number.isSafeInteger(declared) && declared > manifestMaxBytes) {
        throw new ApiError(ApiError.INTEGRITY, 'manifest exceeds the size limit');
      }
    }

    let text;
    try {
      text = await res.text();
    } catch {
      throw new ApiError(ApiError.SCHEMA, 'could not read manifest body');
    }
    if (new TextEncoder().encode(text).length > manifestMaxBytes) {
      throw new ApiError(ApiError.INTEGRITY, 'manifest exceeds the size limit');
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(ApiError.SCHEMA, 'invalid manifest payload');
    }
    return validateManifest(body);
  }

  async function getDocument(id, etag) {
    const encodedId = encodeURIComponent(id);
    const headers = authHeaders();
    if (etag !== undefined && etag !== null) {
      headers['If-None-Match'] = etag;
    }
    const res = await request(`/v1/documents/${encodedId}`, { headers });
    if (res.status === 304) {
      // Not modified: caller keeps its cached copy; body is never read.
      return null;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const mediaType = contentType.split(';')[0].trim().toLowerCase();
    if (mediaType !== 'text/markdown') {
      throw new ApiError(ApiError.SCHEMA, 'unexpected document content type');
    }

    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader !== null && contentLengthHeader !== '') {
      const declared = Number(contentLengthHeader);
      if (Number.isSafeInteger(declared) && declared > markdownMaxBytes) {
        throw new ApiError(ApiError.INTEGRITY, 'document exceeds the size limit');
      }
    }

    let text;
    try {
      text = await res.text();
    } catch {
      throw new ApiError(ApiError.SCHEMA, 'could not read document body');
    }
    if (new TextEncoder().encode(text).length > markdownMaxBytes) {
      throw new ApiError(ApiError.INTEGRITY, 'document exceeds the size limit');
    }

    return { text, etag: res.headers.get('etag') };
  }

  function artifactUrl(id) {
    return `${origin}/v1/artifacts/${encodeURIComponent(id)}`;
  }

  /** Ask response cap — generous (a 2k-token answer ≈ tens of KB), still bounded. */
  const ASK_ANSWER_MAX_BYTES = 512 * 1024; // 512 KiB

  /**
   * Ask the knowledge-base assistant. `knowledge` is the client-side retrieved
   * context (title/excerpt/relativePath chunks from the local cache); the
   * server composes the prompt and calls the LLM provider, and the plaintext
   * provider key never leaves the server.
   *
   * `history` carries the current conversation's prior turns so the assistant
   * is not isolated per question: [{role: 'user'|'assistant', content}],
   * oldest first, excluding the current question itself. Pass [] for a fresh
   * conversation (or to omit context entirely).
   */
  async function askQuestion(question, knowledge = [], history = []) {
    const res = await request('/v1/ask', {
      method: 'POST',
      // Fastify 只解析带 Content-Type: application/json 的 body——缺失会 400/415。
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: { question, knowledge, history },
      allowedStatuses: [503, 504],
    });
    if (res.status === 503) {
      throw new ApiError(ApiError.ASSISTANT_UNAVAILABLE, 'assistant not configured', { status: 503 });
    }
    if (res.status === 504) {
      throw new ApiError(ApiError.ASSISTANT_TIMEOUT, 'assistant timed out', { status: 504 });
    }
    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader !== null && contentLengthHeader !== '') {
      const declared = Number(contentLengthHeader);
      if (Number.isSafeInteger(declared) && declared > ASK_ANSWER_MAX_BYTES) {
        throw new ApiError(ApiError.INTEGRITY, 'assistant answer exceeds the size limit');
      }
    }
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new ApiError(ApiError.SCHEMA, 'invalid ask response');
    }
    if (!isObject(payload) || typeof payload.answer !== 'string' || payload.answer.trim() === '') {
      throw new ApiError(ApiError.SCHEMA, 'invalid ask response');
    }
    return { answer: payload.answer };
  }

  /** 文件传输列表：GET /v1/files → [{id, name, size, mtime}]。 */
  async function listFiles() {
    const res = await request('/v1/files', { headers: authHeaders() });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new ApiError(ApiError.SCHEMA, 'invalid files response');
    }
    if (!isObject(body) || !Array.isArray(body.files)) {
      throw new ApiError(ApiError.SCHEMA, 'invalid files response');
    }
    return body.files.map((f) => {
      if (
        !isObject(f) ||
        typeof f.id !== 'string' ||
        !ENTRY_ID_RE.test(f.id) ||
        typeof f.name !== 'string' ||
        f.name === '' ||
        typeof f.size !== 'number' ||
        !Number.isInteger(f.size) ||
        f.size < 0 ||
        !isValidIsoDatetime(f.mtime)
      ) {
        throw new ApiError(ApiError.SCHEMA, 'invalid files response');
      }
      return { id: f.id, name: f.name, size: f.size, mtime: f.mtime };
    });
  }

  /** 文件传输下载 URL（无凭据，下载时带 Bearer）。 */
  function fileUrl(id) {
    return `${origin}/v1/files/${encodeURIComponent(id)}`;
  }

  return { health, getManifest, getDocument, artifactUrl, askQuestion, listFiles, fileUrl };
}