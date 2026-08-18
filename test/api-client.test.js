import { describe, it, expect } from 'vitest';
import { ApiError, createApiClient, MANIFEST_MAX_BYTES } from '../src/api-client.js';

/**
 * Test-only fake device token: valid shape per the production pattern,
 * generated in test source so it can never be confused with a real issued secret.
 */
function fakeToken() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let body = '';
  for (let i = 0; i < 43; i += 1) body += alphabet[i % alphabet.length];
  return 'uak_' + body;
}

const FAKE_TOKEN = fakeToken();
const BASE = 'https://api.example.com';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function authHeaderEntries(opts) {
  const headers = opts?.headers ?? {};
  return Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization');
}

function makeClient({ token = FAKE_TOKEN, markdownMaxBytes } = {}) {
  return createApiClient({
    baseUrl: BASE,
    token,
    fetchImpl: () => {
      throw new Error('unreachable: fetchImpl must be injected per test');
    },
    markdownMaxBytes,
  });
}

describe('ApiError', () => {
  it('exposes the stable error codes', () => {
    expect(ApiError.NETWORK).toBe('NETWORK');
    expect(ApiError.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ApiError.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ApiError.SERVER).toBe('SERVER');
    expect(ApiError.SCHEMA).toBe('SCHEMA');
    expect(ApiError.INTEGRITY).toBe('INTEGRITY');
    expect(ApiError.NOT_FOUND).toBe('NOT_FOUND');
    expect(ApiError.REQUEST).toBe('REQUEST');
  });

  it('carries code/status and serializes without leaking any request data', () => {
    const err = new ApiError(ApiError.NOT_FOUND, 'not found', { status: 404 });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
    const serialized = JSON.stringify(err);
    expect(serialized).toContain('NOT_FOUND');
    expect(serialized).not.toContain(FAKE_TOKEN);
  });
});

describe('health()', () => {
  it('GETs /v1/health with no Authorization header and returns ok:true', async () => {
    let captured;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async (url, opts) => {
        captured = { url, opts };
        return jsonResponse({ ok: true });
      },
    });
    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(captured.url).toBe(`${BASE}/v1/health`);
    expect(captured.opts.method).toBe('GET');
    expect(authHeaderEntries(captured.opts)).toHaveLength(0);
  });

  it('rejects a response that is not the exact {ok:true} contract', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ ok: false }),
    });
    await expect(client.health()).rejects.toMatchObject({ code: ApiError.SCHEMA });
  });

  it('rejects a malformed health body', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => new Response('<html>nope</html>', { status: 200 }),
    });
    await expect(client.health()).rejects.toMatchObject({ code: ApiError.SCHEMA });
  });

  it('maps 401 to UNAUTHORIZED and 5xx to SERVER', async () => {
    let status = 401;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => ({ status, ok: false, headers: { get: () => null } }),
    });
    await expect(client.health()).rejects.toMatchObject({ code: ApiError.UNAUTHORIZED });
    status = 503;
    await expect(client.health()).rejects.toMatchObject({ code: ApiError.SERVER });
  });

  it('maps fetch rejection to NETWORK without leaking the underlying message', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => {
        throw new Error(`socket exploded with ${FAKE_TOKEN}`);
      },
    });
    const err = await client.health().then(
      () => null,
      (e) => e,
    );
    expect(err).toMatchObject({ code: ApiError.NETWORK });
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(err)).not.toContain(FAKE_TOKEN);
  });
});

describe('getManifest()', () => {
  // id: exactly 43-char base64url (a-z 26 + A-Z 17 = 43)
  const ENTRY_ID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
  const validEntry = {
    id: ENTRY_ID,
    relativePath: 'wiki/welcome.md',
    kind: 'document',
    mime: 'text/markdown; charset=utf-8',
    size: 1234,
    mtime: '2026-08-17T00:00:00.000Z',
    sha256: 'ab'.repeat(32),
    title: 'Welcome',
  };
  const validManifest = {
    schemaVersion: 1,
    generatedAt: '2026-08-17T00:00:00.000Z',
    revision: 'cd'.repeat(32),
    entries: [validEntry],
  };

  function clientWith(manifest) {
    return createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse(manifest),
    });
  }

  it('GETs /v1/manifest with exactly one Authorization header and returns the full validated manifest shape', async () => {
    let captured;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async (url, opts) => {
        captured = { url, opts };
        return jsonResponse(validManifest);
      },
    });
    const result = await client.getManifest();
    expect(captured.url).toBe(`${BASE}/v1/manifest`);
    expect(captured.opts.method).toBe('GET');
    const authKeys = authHeaderEntries(captured.opts);
    expect(authKeys).toHaveLength(1);
    expect(captured.opts.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(result).toEqual(validManifest);
    expect(Object.keys(result).sort()).toEqual(['entries', 'generatedAt', 'revision', 'schemaVersion']);
  });

  it('rejects content-length above the manifest cap with INTEGRITY before reading the body', async () => {
    let bodyRead = false;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      manifestMaxBytes: 1024,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: {
          get: (name) => (name.toLowerCase() === 'content-length' ? '2048' : null),
        },
        text: async () => {
          bodyRead = true;
          return '';
        },
        json: async () => {
          bodyRead = true;
          return {};
        },
      }),
    });
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.INTEGRITY });
    expect(bodyRead).toBe(false);
  });

  it('rejects an oversized manifest body with INTEGRITY', async () => {
    // A single valid entry with a very long title keeps the test tiny while
    // pushing the serialized body past the configured cap.
    const hugeTitleEntry = { ...validEntry, title: 'x'.repeat(5000) };
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      manifestMaxBytes: 1024,
      fetchImpl: async () => jsonResponse({ ...validManifest, entries: [hugeTitleEntry] }),
    });
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.INTEGRITY });
  });

  it('accepts a valid manifest under a small manifest cap (cap does not break parsing)', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      manifestMaxBytes: 4096,
      fetchImpl: async () => jsonResponse(validManifest),
    });
    await expect(client.getManifest()).resolves.toEqual(validManifest);
  });

  it('parses without a content-length header when the actual body fits the cap', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      manifestMaxBytes: 4096,
      fetchImpl: async () =>
        new Response(JSON.stringify(validManifest), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(client.getManifest()).resolves.toEqual(validManifest);
  });

  it('accepts valid document and artifact entries across the whole allowlist', async () => {
    const variants = [
      { relativePath: 'wiki/a.md', kind: 'document', mime: 'text/markdown; charset=utf-8' },
      { relativePath: 'wiki/sub/deep/note.md', kind: 'document', mime: 'text/markdown; charset=utf-8' },
      { relativePath: 'outputs/report.md', kind: 'document', mime: 'text/markdown; charset=utf-8' },
      { relativePath: 'outputs/app.apk', kind: 'artifact', mime: 'application/vnd.android.package-archive' },
      // Cross-repo contract: extensions match case-insensitively, the original
      // relativePath is preserved verbatim, and the kind MIME stays exact.
      { relativePath: 'outputs/Report.MD', kind: 'document', mime: 'text/markdown; charset=utf-8' },
      { relativePath: 'outputs/App.APK', kind: 'artifact', mime: 'application/vnd.android.package-archive' },
    ];
    for (const v of variants) {
      const client = clientWith({ ...validManifest, entries: [{ ...validEntry, ...v }] });
      await expect(client.getManifest(), `entry=${JSON.stringify(v)}`).resolves.toMatchObject({
        entries: [expect.objectContaining(v)],
      });
    }
  });

  it('rejects uppercase allowlist prefixes (mirrors the server startsWith semantics)', async () => {
    // The server matches the `wiki/` / `outputs/` prefix case-sensitively;
    // the client must reject entries a real server could never emit.
    for (const relativePath of ['WIKI/a.md', 'Outputs/report.md', 'WIKI/sub/a.md']) {
      const client = clientWith({ ...validManifest, entries: [{ ...validEntry, relativePath }] });
      await expect(client.getManifest(), `entry=${relativePath}`).rejects.toMatchObject({
        code: ApiError.SCHEMA,
      });
    }
  });

  it('accepts valid ISO datetime mtimes with Z or an explicit offset', async () => {
    for (const mtime of ['2026-08-17T08:30:00+08:00', '2024-01-01T00:00:00Z', '2026-08-17T23:59:59.999Z']) {
      const client = clientWith({ ...validManifest, entries: [{ ...validEntry, mtime }] });
      await expect(client.getManifest(), `mtime=${mtime}`).resolves.toMatchObject({
        entries: [expect.objectContaining({ mtime })],
      });
    }
  });

  it('rejects an unknown schema version', async () => {
    const client = clientWith({ ...validManifest, schemaVersion: 2 });
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.SCHEMA });
  });

  it('rejects a missing schema version', async () => {
    const { schemaVersion, ...rest } = validManifest;
    const client = clientWith(rest);
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.SCHEMA });
  });

  it('rejects a missing, non-string, or malformed revision (lowercase 64 hex required)', async () => {
    const mutants = [
      { ...validManifest, revision: undefined },
      { ...validManifest, revision: 42 },
      { ...validManifest, revision: 'rev-2026-001' },
      { ...validManifest, revision: 'AB'.repeat(32) },
      { ...validManifest, revision: 'a'.repeat(63) },
      { ...validManifest, revision: 'g'.repeat(64) },
    ];
    for (const manifest of mutants) {
      const client = clientWith(manifest);
      await expect(
        client.getManifest(),
        `revision=${JSON.stringify(manifest.revision)}`,
      ).rejects.toMatchObject({ code: ApiError.SCHEMA });
    }
  });

  it('rejects a missing or invalid generatedAt timestamp', async () => {
    const mutants = [
      { ...validManifest, generatedAt: undefined },
      { ...validManifest, generatedAt: 1700000000 },
      { ...validManifest, generatedAt: 'not-a-date' },
      { ...validManifest, generatedAt: '2026-13-99T00:00:00.000Z' },
      { ...validManifest, generatedAt: '2026-08-17' },
    ];
    for (const manifest of mutants) {
      const client = clientWith(manifest);
      await expect(
        client.getManifest(),
        `generatedAt=${JSON.stringify(manifest.generatedAt)}`,
      ).rejects.toMatchObject({ code: ApiError.SCHEMA });
    }
  });

  it('rejects entries that are not an array', async () => {
    const client = clientWith({ ...validManifest, entries: 'nope' });
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.SCHEMA });
  });

  it('rejects entries that use the legacy path field instead of relativePath', async () => {
    const { relativePath, ...legacyEntry } = validEntry;
    const client = clientWith({
      ...validManifest,
      entries: [{ ...legacyEntry, path: 'wiki/welcome.md' }],
    });
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.SCHEMA });
  });

  it('rejects entry ids that are not exactly 43-char base64url', async () => {
    const badIds = [
      '',
      'short-id',
      'a'.repeat(42),
      'a'.repeat(44),
      'a'.repeat(42) + '+',
      'a'.repeat(42) + '=',
      'a'.repeat(42) + '/',
      'a'.repeat(42) + '?',
    ];
    for (const id of badIds) {
      const client = clientWith({ ...validManifest, entries: [{ ...validEntry, id }] });
      await expect(client.getManifest(), `id=${JSON.stringify(id)}`).rejects.toMatchObject({
        code: ApiError.SCHEMA,
      });
    }
  });

  it('rejects relativePaths outside the allowlist or with forbidden segments', async () => {
    const badPaths = [
      '',
      '   ',
      'missing',
      '../../etc/passwd',
      '/abs/path.md',
      'a\\b.md',
      'raw/secret.md',
      'books/x.md',
      'wiki/x.txt',
      'wiki/x.apk',
      'wiki/x',
      'wiki/',
      'wiki//x.md',
      'wiki/./x.md',
      'wiki/a/../b.md',
      'outputs/x.apk/',
      'wiki/.hidden.md',
      'wiki/sub/.hidden/x.md',
      'outputs/.dot.apk',
      'wiki/_tmp-x.md',
      'wiki/_tmp/x.md',
      'wiki/node_modules/x.md',
    ];
    for (const relativePath of badPaths) {
      const client = clientWith({
        ...validManifest,
        entries: [{ ...validEntry, relativePath }],
      });
      await expect(
        client.getManifest(),
        `relativePath=${JSON.stringify(relativePath)}`,
      ).rejects.toMatchObject({ code: ApiError.SCHEMA });
    }
  });

  it('rejects _tmp and node_modules segments case-insensitively', async () => {
    const badPaths = [
      'wiki/_TMP-x.md',
      'wiki/_TMP/x.md',
      'wiki/NODE_MODULES/x.md',
      'outputs/NODE_MODULES/x.md',
    ];
    for (const relativePath of badPaths) {
      const client = clientWith({
        ...validManifest,
        entries: [{ ...validEntry, relativePath }],
      });
      await expect(
        client.getManifest(),
        `relativePath=${JSON.stringify(relativePath)}`,
      ).rejects.toMatchObject({ code: ApiError.SCHEMA });
    }
  });

  it('rejects kind values other than the exact document/artifact pair', async () => {
    const badKinds = ['page', 'md', 'wiki', 'documentation', '', 42, null];
    for (const kind of badKinds) {
      const client = clientWith({ ...validManifest, entries: [{ ...validEntry, kind }] });
      await expect(client.getManifest(), `kind=${JSON.stringify(kind)}`).rejects.toMatchObject({
        code: ApiError.SCHEMA,
      });
    }
  });

  it('rejects kind/mime/extension mismatches', async () => {
    const mutants = [
      // kind does not match the relativePath extension
      { ...validEntry, relativePath: 'outputs/app.apk' }, // still kind document
      { ...validEntry, kind: 'artifact' }, // but path is wiki/*.md
      // mime does not match the kind
      { ...validEntry, mime: 'application/vnd.android.package-archive' },
      {
        ...validEntry,
        relativePath: 'outputs/app.apk',
        kind: 'artifact',
        mime: 'text/markdown; charset=utf-8',
      },
      // charset must be present for markdown
      { ...validEntry, mime: 'text/markdown' },
      // any other mime is rejectable
      { ...validEntry, mime: 'application/octet-stream' },
      { ...validEntry, relativePath: 'wiki/x.txt', mime: 'text/markdown; charset=utf-8' },
    ];
    for (const entry of mutants) {
      const client = clientWith({ ...validManifest, entries: [entry] });
      await expect(
        client.getManifest(),
        `entry=${JSON.stringify(entry)}`,
      ).rejects.toMatchObject({ code: ApiError.SCHEMA });
    }
  });

  it('rejects non-string, non-ISO, or invalid mtime values', async () => {
    const badMtimes = [
      1700000000,
      '1700000000',
      'yesterday',
      '2026-13-99T00:00:00.000Z',
      '2026-02-30T00:00:00.000Z',
      '2026-08-17',
      null,
    ];
    for (const mtime of badMtimes) {
      const client = clientWith({ ...validManifest, entries: [{ ...validEntry, mtime }] });
      await expect(client.getManifest(), `mtime=${JSON.stringify(mtime)}`).rejects.toMatchObject({
        code: ApiError.SCHEMA,
      });
    }
  });

  it('rejects sha256 values that are not lowercase 64 hex', async () => {
    const badHashes = ['not-a-hash', 'a'.repeat(63), 'xyz'.repeat(22), 'AB'.repeat(32), 42, null];
    for (const sha256 of badHashes) {
      const client = clientWith({ ...validManifest, entries: [{ ...validEntry, sha256 }] });
      await expect(client.getManifest(), `sha256=${JSON.stringify(sha256)}`).rejects.toMatchObject({
        code: ApiError.SCHEMA,
      });
    }
  });

  it('rejects empty or non-string titles', async () => {
    const badTitles = ['', '   ', null, 42];
    for (const title of badTitles) {
      const client = clientWith({ ...validManifest, entries: [{ ...validEntry, title }] });
      await expect(client.getManifest(), `title=${JSON.stringify(title)}`).rejects.toMatchObject({
        code: ApiError.SCHEMA,
      });
    }
  });

  it('rejects entries with missing or wrong-typed required fields', async () => {
    const mutants = [
      { ...validEntry, size: -1 },
      { ...validEntry, size: 'big' },
      { ...validEntry, size: 1.5 },
    ];
    for (const entry of mutants) {
      const client = clientWith({ ...validManifest, entries: [entry] });
      await expect(client.getManifest(), `entry=${JSON.stringify(entry)}`).rejects.toMatchObject({
        code: ApiError.SCHEMA,
      });
    }
  });

  it('tolerates extra unknown fields on entries', async () => {
    const entry = { ...validEntry, extra: 'ignored', flags: { hidden: true } };
    const client = clientWith({ ...validManifest, entries: [entry] });
    await expect(client.getManifest()).resolves.toEqual({
      ...validManifest,
      entries: [entry],
    });
  });

  it('maps error statuses without reading the response body', async () => {
    let status = 401;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => ({
        status,
        ok: status < 400,
        headers: { get: () => null },
      }),
    });
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.UNAUTHORIZED });
    status = 404;
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.NOT_FOUND });
    status = 429;
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.RATE_LIMITED });
    status = 503;
    await expect(client.getManifest()).rejects.toMatchObject({ code: ApiError.SERVER });
  });

  it('maps other 4xx statuses (not 401/404/429) to REQUEST', async () => {
    for (const status of [400, 403, 418, 422]) {
      const client = createApiClient({
        baseUrl: BASE,
        token: FAKE_TOKEN,
        fetchImpl: async () => ({
          status,
          ok: false,
          headers: { get: () => null },
        }),
      });
      await expect(client.getManifest(), `status=${status}`).rejects.toMatchObject({
        code: ApiError.REQUEST,
      });
    }
  });

  it('parses a safe integer Retry-After but ignores non-integer values', async () => {
    let retryAfter = '30';
    let client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => ({
        status: 429,
        ok: false,
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
      }),
    });
    let err = await client.getManifest().then(
      () => null,
      (e) => e,
    );
    expect(err.code).toBe(ApiError.RATE_LIMITED);
    expect(err.retryAfterSeconds).toBe(30);
    expect(JSON.stringify(err)).not.toContain(FAKE_TOKEN);

    retryAfter = 'not-a-number';
    client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => ({
        status: 429,
        ok: false,
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
      }),
    });
    err = await client.getManifest().then(
      () => null,
      (e) => e,
    );
    expect(err.code).toBe(ApiError.RATE_LIMITED);
    expect(err.retryAfterSeconds).toBeNull();
  });

  it('maps network failure to NETWORK with redacted message', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => {
        throw new Error(`connection refused, token=${FAKE_TOKEN}`);
      },
    });
    const err = await client.getManifest().then(
      () => null,
      (e) => e,
    );
    expect(err.code).toBe(ApiError.NETWORK);
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(err)).not.toContain(FAKE_TOKEN);
  });

  it('times out a hung request with NETWORK instead of hanging forever', async () => {
    // fetchImpl that never settles, ignoring any signal — the client must
    // still fail via the race timeout.
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}),
    });
    const err = await client.getManifest().then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect(err.code).toBe(ApiError.NETWORK);
    expect(err.message).not.toContain(FAKE_TOKEN);
  });

  it('a fast response is not affected by the timeout', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      timeoutMs: 5_000,
      fetchImpl: async () => jsonResponse({ ok: true }),
    });
    await expect(client.health()).resolves.toEqual({ ok: true });
  });
});

describe('getDocument()', () => {
  it('GETs /v1/documents/:id with auth, returns text+etag for markdown', async () => {
    let captured;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async (url, opts) => {
        captured = { url, opts };
        return new Response('# Hello', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8', etag: '"v1"' },
        });
      },
    });
    const result = await client.getDocument('doc-1');
    expect(captured.url).toBe(`${BASE}/v1/documents/doc-1`);
    expect(captured.opts.method).toBe('GET');
    expect(authHeaderEntries(captured.opts)).toHaveLength(1);
    expect(captured.opts.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(captured.opts.headers['If-None-Match']).toBeUndefined();
    expect(result).toEqual({ text: '# Hello', etag: '"v1"' });
  });

  it('URL-encodes the document id', async () => {
    let capturedUrl;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async (url) => {
        capturedUrl = url;
        return new Response('x', {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        });
      },
    });
    await client.getDocument('doc 1/é?x');
    expect(capturedUrl).toBe(`${BASE}/v1/documents/${encodeURIComponent('doc 1/é?x')}`);
  });

  it('sends If-None-Match when an etag is provided and returns null for 304 without reading the body', async () => {
    let captured;
    let bodyRead = false;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async (url, opts) => {
        captured = { url, opts };
        return {
          status: 304,
          ok: false,
          headers: { get: () => null },
          text: async () => {
            bodyRead = true;
            return 'SHOULD NOT BE READ';
          },
          json: async () => {
            bodyRead = true;
            return {};
          },
        };
      },
    });
    await expect(client.getDocument('doc-1', '"v1"')).resolves.toBeNull();
    expect(captured.opts.headers['If-None-Match']).toBe('"v1"');
    expect(captured.opts.headers['if-none-match']).toBeUndefined();
    expect(bodyRead).toBe(false);
  });

  it('rejects a non-markdown content type with SCHEMA', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ text: '# Hello' }),
    });
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ code: ApiError.SCHEMA });
  });

  it('rejects content-length above the maximum with INTEGRITY before reading the body', async () => {
    let bodyRead = false;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      markdownMaxBytes: 1024,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: {
          get: (name) => {
            const key = name.toLowerCase();
            if (key === 'content-length') return '2048';
            if (key === 'content-type') return 'text/markdown; charset=utf-8';
            return null;
          },
        },
        text: async () => {
          bodyRead = true;
          return '';
        },
      }),
    });
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ code: ApiError.INTEGRITY });
    expect(bodyRead).toBe(false);
  });

  it('rejects an oversized body with INTEGRITY', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      markdownMaxBytes: 1024,
      fetchImpl: async () =>
        new Response('# ' + 'x'.repeat(2048), {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        }),
    });
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ code: ApiError.INTEGRITY });
  });

  it('accepts a body at exactly the maximum size', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      markdownMaxBytes: 16,
      fetchImpl: async () =>
        new Response('# ' + 'x'.repeat(13), {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        }),
    });
    await expect(client.getDocument('doc-1')).resolves.toMatchObject({
      text: '# ' + 'x'.repeat(13),
    });
  });

  it('maps error statuses and network failures with redaction', async () => {
    let status = 401;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => ({
        status,
        ok: false,
        headers: { get: () => null },
      }),
    });
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ code: ApiError.UNAUTHORIZED });
    status = 404;
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ code: ApiError.NOT_FOUND });
    status = 429;
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ code: ApiError.RATE_LIMITED });
    status = 503;
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ code: ApiError.SERVER });

    const networkClient = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => {
        throw new Error(`dns failed token=${FAKE_TOKEN}`);
      },
    });
    const err = await networkClient.getDocument('doc-1').then(
      () => null,
      (e) => e,
    );
    expect(err.code).toBe(ApiError.NETWORK);
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(err)).not.toContain(FAKE_TOKEN);
  });

  it('maps a body read failure to SCHEMA', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: { get: () => 'text/markdown' },
        text: async () => {
          throw new Error('stream corrupted');
        },
      }),
    });
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ code: ApiError.SCHEMA });
  });
});

describe('createApiClient() construction validation', () => {
  it('throws TypeError when baseUrl is missing, not a string, or invalid', () => {
    const invalidInputs = [
      undefined,
      null,
      42,
      '',
      '   ',
      'not-a-url',
      'ftp://example.com',
      'https://example.com/kb?tree=1',
    ];
    for (const baseUrl of invalidInputs) {
      expect(
        () => createApiClient({ baseUrl, token: FAKE_TOKEN }),
        `baseUrl=${JSON.stringify(baseUrl)}`,
      ).toThrow(TypeError);
    }
  });

  it('throws TypeError when token is missing or has an invalid shape', () => {
    expect(() => createApiClient({ baseUrl: BASE, token: undefined })).toThrow(TypeError);
    expect(() => createApiClient({ baseUrl: BASE, token: null })).toThrow(TypeError);
    expect(() => createApiClient({ baseUrl: BASE, token: 42 })).toThrow(TypeError);
    expect(() => createApiClient({ baseUrl: BASE, token: 'not-a-token' })).toThrow(TypeError);
    expect(() => createApiClient({ baseUrl: BASE, token: 'tok_' + 'a'.repeat(43) })).toThrow(
      TypeError,
    );
  });

  it('throws early without constructing a working client (validation runs at factory time)', () => {
    const client = createApiClient({ baseUrl: BASE, token: FAKE_TOKEN });
    expect(client).toBeDefined();
    expect(() => createApiClient({ baseUrl: BASE })).toThrow(TypeError);
    expect(() => createApiClient({ token: FAKE_TOKEN })).toThrow(TypeError);
  });

  it('never echoes the candidate token in construction errors', () => {
    const evil = 'tok_' + 'a'.repeat(42) + '+';
    let message = '';
    try {
      createApiClient({ baseUrl: BASE, token: evil });
    } catch (err) {
      message = err.message;
    }
    expect(message).not.toContain(evil);
    expect(message).not.toContain('tok_');
    expect(message.toLowerCase()).toContain('token');
  });

  it('normalizes the base URL via the shared connection-store rule (trailing slashes stripped)', () => {
    const client = createApiClient({ baseUrl: 'https://api.example.com/kb///', token: FAKE_TOKEN });
    expect(client.artifactUrl('a')).toBe('https://api.example.com/kb/v1/artifacts/a');
  });
});

describe('artifactUrl()', () => {
  it('returns the encoded artifact URL without any token', () => {
    const client = makeClient();
    const id = 'art 1/é?';
    const url = client.artifactUrl(id);
    expect(url).toBe(`${BASE}/v1/artifacts/${encodeURIComponent(id)}`);
    expect(url).not.toContain(FAKE_TOKEN);
    expect(url).not.toMatch(/[?&]token=/);
    expect(url).toMatch(/^https:\/\//);
  });
});

describe('askQuestion()', () => {
  it('POSTs question + knowledge to /v1/ask with the bearer token and returns the answer', async () => {
    let captured;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async (url, opts) => {
        captured = { url, opts };
        return jsonResponse({ answer: '知识库在 wiki/ 下。' });
      },
    });
    const knowledge = [{ title: 't', excerpt: 'e', relativePath: 'wiki/a.md' }];
    const result = await client.askQuestion('知识库在哪？', knowledge);
    expect(result.answer).toBe('知识库在 wiki/ 下。');
    expect(captured.url).toBe(`${BASE}/v1/ask`);
    expect(captured.opts.method).toBe('POST');
    expect(JSON.parse(captured.opts.body)).toEqual({ question: '知识库在哪？', knowledge });
    expect(authHeaderEntries(captured.opts).length).toBe(1);
  });

  it('never sends the token in the body or URL', async () => {
    let captured;
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async (url, opts) => {
        captured = { url, opts };
        return jsonResponse({ answer: 'ok' });
      },
    });
    await client.askQuestion('hi');
    expect(String(captured.opts.body)).not.toContain(FAKE_TOKEN);
    expect(String(captured.url)).not.toContain(FAKE_TOKEN);
  });

  it('maps 503 to ASSISTANT_UNAVAILABLE', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ error: 'assistant_not_configured' }, { status: 503 }),
    });
    await expect(client.askQuestion('hi')).rejects.toMatchObject({
      code: 'ASSISTANT_UNAVAILABLE',
      status: 503,
    });
  });

  it('maps 504 to ASSISTANT_TIMEOUT', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ error: 'assistant_timeout' }, { status: 504 }),
    });
    await expect(client.askQuestion('hi')).rejects.toMatchObject({
      code: 'ASSISTANT_TIMEOUT',
      status: 504,
    });
  });

  it('maps 429 to RATE_LIMITED and 500 to SERVER', async () => {
    const rateLimited = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ error: 'rate_limit_exceeded' }, { status: 429 }),
    });
    await expect(rateLimited.askQuestion('hi')).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const serverError = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse({ error: 'boom' }, { status: 500 }),
    });
    await expect(serverError.askQuestion('hi')).rejects.toMatchObject({ code: 'SERVER' });
  });

  it('rejects a malformed or empty answer payload with SCHEMA', async () => {
    for (const body of [{}, { answer: '' }, { answer: '   ' }, { answer: 42 }, 'nope']) {
      const client = createApiClient({
        baseUrl: BASE,
        token: FAKE_TOKEN,
        fetchImpl: async () => jsonResponse(body),
      });
      await expect(client.askQuestion('hi')).rejects.toMatchObject({ code: 'SCHEMA' });
    }
  });

  it('maps network failure and timeout to NETWORK', async () => {
    const network = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(network.askQuestion('hi')).rejects.toMatchObject({ code: 'NETWORK' });

    const hung = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}),
    });
    await expect(hung.askQuestion('hi')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('rejects an oversized answer via content-length with INTEGRITY', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      token: FAKE_TOKEN,
      fetchImpl: async () =>
        new Response(JSON.stringify({ answer: 'x'.repeat(1024) }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 * 1024) },
        }),
    });
    await expect(client.askQuestion('hi')).rejects.toMatchObject({ code: 'INTEGRITY' });
  });
});