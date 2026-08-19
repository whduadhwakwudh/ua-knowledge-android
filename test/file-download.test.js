import { describe, expect, it } from 'vitest';
import { downloadFile, FileDownloadError } from '../src/file-download.js';

/**
 * 文件传输下载单测——插件调用全部注入 mock，不触网不落盘。
 */

const ENTRY = { id: 'a'.repeat(43), name: '报告 2026.pdf' };
const BASE = 'https://api.example.com';
const TOKEN = 'uak_' + 'A'.repeat(43);

describe('downloadFile — 文件传输', () => {
  it('native path downloads to app-private downloads/ with auth header and opens the file', async () => {
    const calls = [];
    const result = await downloadFile({
      entry: ENTRY,
      apiBaseUrl: BASE,
      token: TOKEN,
      getUriImpl: async ({ directory, path }) => {
        calls.push(['getUri', path]);
        return { uri: 'file:///data/user/0/app/downloads/报告_2026.pdf' };
      },
      downloadImpl: async ({ url, path, headers }) => {
        calls.push(['download', url, path, headers]);
        return { path: 'file:///data/user/0/app/downloads/报告_2026.pdf' };
      },
      openImpl: async (opts) => {
        calls.push(['open', opts]);
      },
    });
    expect(result.fileName).toBe('报告_2026.pdf');
    expect(calls[0]).toEqual(['getUri', 'downloads/报告_2026.pdf']);
    expect(calls[1][1]).toBe(BASE + '/v1/files/' + ENTRY.id);
    expect(calls[1][3].Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[2][1].filePath).toContain('报告_2026.pdf');
    expect(calls[2][1].contentType).toBe('application/octet-stream');
  });

  it('sanitizes the file name to keep it within a safe downloads/ path', async () => {
    const entry = { id: ENTRY.id, name: '../../etc/passwd.txt' };
    let savedPath = '';
    await downloadFile({
      entry,
      apiBaseUrl: BASE,
      token: TOKEN,
      getUriImpl: async ({ path }) => {
        savedPath = path;
        return { uri: 'file:///data/' + path };
      },
      downloadImpl: async ({ path }) => ({ path }),
      openImpl: async () => {},
    });
    // 路径分隔符被替换：保存路径永远只有 downloads/ + 单个文件名，不会逃出。
    expect(savedPath.startsWith('downloads/')).toBe(true);
    expect(savedPath.split('/').length).toBe(2);
    expect(savedPath).not.toContain('\\');
    expect(savedPath).not.toMatch(/\.\.[\\/]/);
  });

  it('web fallback (downloadImpl null) fetches and returns a blob', async () => {
    const fetchImpl = async (url, opts) => {
      expect(url).toBe(BASE + '/v1/files/' + ENTRY.id);
      expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      // 注入自定义 blob mock，避免测试环境 Blob 实现的差异。
      return {
        ok: true,
        blob: async () => ({
          size: 'pdf-bytes'.length,
          text: async () => 'pdf-bytes',
        }),
      };
    };
    const result = await downloadFile({
      entry: ENTRY,
      apiBaseUrl: BASE,
      token: TOKEN,
      downloadImpl: null,
      fetchImpl,
    });
    expect(result.fileName).toBe('报告_2026.pdf');
    expect(result.size).toBe('pdf-bytes'.length);
    expect(await result.blob.text()).toBe('pdf-bytes');
  });

  it('web fallback maps HTTP errors and network failures', async () => {
    await expect(
      downloadFile({
        entry: ENTRY,
        apiBaseUrl: BASE,
        token: TOKEN,
        downloadImpl: null,
        fetchImpl: async () => new Response('nope', { status: 404 }),
      }),
    ).rejects.toMatchObject({ code: 'HTTP' });

    await expect(
      downloadFile({
        entry: ENTRY,
        apiBaseUrl: BASE,
        token: TOKEN,
        downloadImpl: null,
        fetchImpl: async () => {
          throw new TypeError('offline');
        },
      }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('exposes stable error codes', () => {
    expect(FileDownloadError.HTTP).toBe('HTTP');
    expect(FileDownloadError.NETWORK).toBe('NETWORK');
    expect(FileDownloadError.IO).toBe('IO');
  });
});
