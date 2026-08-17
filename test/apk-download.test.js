import { describe, it, expect } from 'vitest';
import { downloadAndVerifyApk, sanitizeFilename, ApkDownloadError } from '../src/apk-download.js';

/**
 * APK download + verify tests — every plugin call is injected, so nothing
 * touches the network, the filesystem, or the native plugins.
 */

/** Test-only fake device token (valid shape, built at runtime). */
function fakeToken() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let body = '';
  for (let i = 0; i < 43; i += 1) body += alphabet[i % alphabet.length];
  return 'uak_' + body;
}

const TOKEN = fakeToken();
const DATA_DIR = 'DATA'; // Filesystem Directory.Data enum value on Android
const APK_MIME = 'application/vnd.android.package-archive';
const sha256 = 'a'.repeat(64);

function artifactEntry(overrides = {}) {
  return {
    id: 'artifact-' + 'A'.repeat(32),
    title: '知识库-客户端',
    relativePath: 'outputs/app-release.apk',
    kind: 'artifact',
    mime: APK_MIME,
    size: 4096,
    mtime: '2026-01-02T00:00:00Z',
    sha256,
    ...overrides,
  };
}

function nativePlugins({ hash = sha256, downloadError = null } = {}) {
  const calls = { getUri: [], download: [], hash: [], open: [], delete: [] };
  const plugins = {
    calls,
    getUriImpl: async ({ directory, path }) => {
      calls.getUri.push({ directory, path });
      return { uri: 'file:///data/user/0/io.ua.knowledgebase/files/' + path };
    },
    downloadImpl: async (opts) => {
      calls.download.push(opts);
      if (downloadError) throw downloadError;
      opts.onProgress?.({ percent: 50, bytesSent: 2048, totalBytes: 4096 });
      // FileTransfer resolves to the destination it wrote (already absolute).
      return { path: opts.path };
    },
    nativeHashImpl: async ({ path }) => {
      calls.hash.push(path);
      return { sha256: hash };
    },
    openImpl: async (opts) => {
      calls.open.push(opts);
    },
    deleteImpl: async ({ directory, path }) => {
      calls.delete.push({ directory, path });
    },
  };
  return plugins;
}

describe('sanitizeFilename', () => {
  it('keeps Unicode letters, numbers, dots, underscores and hyphens; spaces collapse to underscores', () => {
    expect(sanitizeFilename('知识库-客户端_v1.2.3_release')).toBe('知识库-客户端_v1.2.3_release');
    expect(sanitizeFilename('UA-KB_v2.0')).toBe('UA-KB_v2.0');
    expect(sanitizeFilename('测试123')).toBe('测试123');
    // Spaces are not in the keep-set, so they are replaced like any other run.
    expect(sanitizeFilename('知识库-客户端 v1.2.3_release')).toBe('知识库-客户端_v1.2.3_release');
  });

  it('replaces runs of any other characters with a single underscore', () => {
    expect(sanitizeFilename('a/b:c?*d')).toBe('a_b_c_d');
    expect(sanitizeFilename('  spaced  out  ')).toBe('_spaced_out_');
    expect(sanitizeFilename('quote"apostrophe\'s')).toBe('quote_apostrophe_s');
    expect(sanitizeFilename('naïve😀emoji')).toBe('naïve_emoji');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('')).toBe('_');
    expect(sanitizeFilename(null)).toBe('_');
    expect(sanitizeFilename('///')).toBe('_');
  });
});

describe('downloadAndVerifyApk — native path (injected plugins)', () => {
  it('downloads to the hashed destination with a Bearer header and reports progress', async () => {
    const entry = artifactEntry();
    const { calls, ...plugins } = nativePlugins();

    const progress = [];
    const result = await downloadAndVerifyApk({
      entry,
      apiBaseUrl: 'https://kb.example.com',
      token: TOKEN,
      onProgress: (info) => progress.push(info),
      ...plugins,
    });

    expect(calls.getUri).toEqual([
      { directory: DATA_DIR, path: `downloads/知识库-客户端-${sha256.slice(0, 12)}.apk` },
    ]);
    expect(calls.download).toHaveLength(1);
    expect(calls.download[0].url).toBe('https://kb.example.com/v1/artifacts/' + encodeURIComponent(entry.id));
    expect(calls.download[0].headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(progress.map((p) => p.percent)).toEqual([50]);

    expect(calls.hash).toEqual([result.uri]);
    expect(result.uri).toMatch(/downloads\/知识库-客户端-aaaaaaaaaaaa\.apk$/);
    expect(result.sha256).toBe(sha256);
    expect(result.fileName).toBe(`知识库-客户端-${sha256.slice(0, 12)}.apk`);

    expect(calls.open).toEqual([
      { filePath: result.uri, contentType: APK_MIME, openWithDefault: true },
    ]);
    expect(calls.delete).toEqual([]);
  });

  it('normalizes an uppercase native hash before the exact lowercase comparison', async () => {
    const entry = artifactEntry();
    const { calls, ...plugins } = nativePlugins({ hash: sha256.toUpperCase() });
    const result = await downloadAndVerifyApk({
      entry,
      apiBaseUrl: 'https://kb.example.com',
      token: TOKEN,
      ...plugins,
    });
    expect(calls.open).toHaveLength(1);
    expect(result.sha256).toBe(sha256);
  });

  it('deletes the file and rejects on any hash mismatch, never opening the file', async () => {
    const entry = artifactEntry();
    const { calls, ...plugins } = nativePlugins({ hash: 'f'.repeat(64) });

    await expect(
      downloadAndVerifyApk({ entry, apiBaseUrl: 'https://kb.example.com', token: TOKEN, ...plugins }),
    ).rejects.toMatchObject({ code: ApkDownloadError.HASH_MISMATCH });

    expect(calls.delete).toEqual([
      { directory: DATA_DIR, path: `downloads/知识库-客户端-${sha256.slice(0, 12)}.apk` },
    ]);
    expect(calls.open).toEqual([]);
  });

  it('propagates a download transport failure without touching the opener', async () => {
    const entry = artifactEntry();
    const downloadError = new Error('transport down');
    const { calls, ...plugins } = nativePlugins({ downloadError });

    await expect(
      downloadAndVerifyApk({ entry, apiBaseUrl: 'https://kb.example.com', token: TOKEN, ...plugins }),
    ).rejects.toBe(downloadError);
    expect(calls.open).toEqual([]);
  });
});

describe('downloadAndVerifyApk — web fallback (injected fetch)', () => {
  function bytesOf(text) {
    return new TextEncoder().encode(text);
  }

  it('downloads via fetch with the Bearer header and verifies the digest', async () => {
    const body = bytesOf('fake apk bytes for hash verification');
    const digest = await crypto.subtle.digest('SHA-256', body);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const entry = artifactEntry({ sha256: hex });

    const calls = { fetch: [], hash: [], open: [], delete: [] };
    const fetchImpl = async (url, opts) => {
      calls.fetch.push({ url, opts });
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer };
    };

    const result = await downloadAndVerifyApk({
      entry,
      apiBaseUrl: 'https://kb.example.com',
      token: TOKEN,
      fetchImpl,
      downloadImpl: null,
      nativeHashImpl: async ({ path }) => {
        calls.hash.push(path);
        return { sha256: hex };
      },
      openImpl: async (opts) => {
        calls.open.push(opts);
      },
      deleteImpl: async ({ directory, path }) => {
        calls.delete.push({ directory, path });
      },
    });

    expect(calls.fetch).toHaveLength(1);
    expect(calls.fetch[0].url).toBe('https://kb.example.com/v1/artifacts/' + encodeURIComponent(entry.id));
    expect(calls.fetch[0].opts.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(result.sha256).toBe(hex);
    expect(Array.from(result.blob)).toEqual(Array.from(body));
    // Web fallback has no on-device file: no opener, no filesystem calls.
    expect(calls.open).toEqual([]);
    expect(calls.hash).toEqual([]);
    expect(calls.delete).toEqual([]);
  });

  it('rejects on a non-ok HTTP response', async () => {
    const entry = artifactEntry();
    const fetchImpl = async () => ({ ok: false, status: 401 });
    await expect(
      downloadAndVerifyApk({
        entry,
        apiBaseUrl: 'https://kb.example.com',
        token: TOKEN,
        fetchImpl,
        downloadImpl: null,
      }),
    ).rejects.toMatchObject({ code: ApkDownloadError.HTTP });
  });

  it('rejects when the fallback digest does not match', async () => {
    const entry = artifactEntry(); // sha256 = 'a' * 64
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf('different bytes').buffer,
    });
    await expect(
      downloadAndVerifyApk({
        entry,
        apiBaseUrl: 'https://kb.example.com',
        token: TOKEN,
        fetchImpl,
        downloadImpl: null,
      }),
    ).rejects.toMatchObject({ code: ApkDownloadError.HASH_MISMATCH });
  });
});