import { describe, expect, it } from 'vitest';
import { downloadFile, FileDownloadError, mimeTypeFor } from '../src/file-download.js';

/**
 * 文件传输下载单测——插件调用全部注入 mock，不触网不落盘。
 */

const ENTRY = { id: 'a'.repeat(43), name: '报告 2026.pdf' };
const BASE = 'https://api.example.com';
const TOKEN = 'uak_' + 'A'.repeat(43);

describe('mimeTypeFor — 扩展名 MIME 映射', () => {
  it('maps common document/image/video/audio extensions', () => {
    expect(mimeTypeFor('a.pdf')).toBe('application/pdf');
    expect(mimeTypeFor('a.DOCX')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeTypeFor('a.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mimeTypeFor('a.md')).toBe('text/markdown');
    expect(mimeTypeFor('a.png')).toBe('image/png');
    expect(mimeTypeFor('a.mp4')).toBe('video/mp4');
    expect(mimeTypeFor('a.mp3')).toBe('audio/mpeg');
    expect(mimeTypeFor('a.apk')).toBe('application/vnd.android.package-archive');
    expect(mimeTypeFor('a.zip')).toBe('application/zip');
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(mimeTypeFor('a.unknownext')).toBe('application/octet-stream');
    expect(mimeTypeFor('noext')).toBe('application/octet-stream');
    expect(mimeTypeFor('')).toBe('application/octet-stream');
    expect(mimeTypeFor(null)).toBe('application/octet-stream');
  });
});

describe('downloadFile — 文件传输', () => {
  it('downloads to app-private downloads/, moves into public Downloads and opens with mapped MIME', async () => {
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
      moveImpl: async ({ path, fileName, mimeType }) => {
        calls.push(['move', path, fileName, mimeType]);
        return { uri: 'content://media/external/downloads/123' };
      },
      openImpl: async (opts) => {
        calls.push(['open', opts]);
      },
    });
    expect(result.fileName).toBe('报告_2026.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.uri).toBe('content://media/external/downloads/123');
    expect(calls[0]).toEqual(['getUri', 'downloads/报告_2026.pdf']);
    expect(calls[1][1]).toBe(BASE + '/v1/files/' + ENTRY.id);
    expect(calls[1][3].Authorization).toBe(`Bearer ${TOKEN}`);
    // 移动调用携带私有路径、净化后的文件名和映射出的 MIME。
    expect(calls[2]).toEqual([
      'move',
      'file:///data/user/0/app/downloads/报告_2026.pdf',
      '报告_2026.pdf',
      'application/pdf',
    ]);
    // 打开使用公共 URI + 映射 MIME。
    expect(calls[3][1].filePath).toBe('content://media/external/downloads/123');
    expect(calls[3][1].contentType).toBe('application/pdf');
  });

  it('sanitizes the file name to keep it within a safe downloads/ path', async () => {
    const entry = { id: ENTRY.id, name: '../../etc/passwd.txt' };
    let savedPath = '';
    let movedName = '';
    await downloadFile({
      entry,
      apiBaseUrl: BASE,
      token: TOKEN,
      getUriImpl: async ({ path }) => {
        savedPath = path;
        return { uri: 'file:///data/' + path };
      },
      downloadImpl: async ({ path }) => ({ path }),
      moveImpl: async ({ fileName }) => {
        movedName = fileName;
        return { uri: 'content://media/external/downloads/1' };
      },
      openImpl: async () => {},
    });
    // 路径分隔符被替换：保存路径永远只有 downloads/ + 单个文件名，不会逃出。
    expect(savedPath.startsWith('downloads/')).toBe(true);
    expect(savedPath.split('/').length).toBe(2);
    expect(savedPath).not.toContain('\\');
    expect(savedPath).not.toMatch(/\.\.[\\/]/);
    // 移入公共目录用的也是净化后的文件名。
    expect(movedName).not.toContain('/');
    expect(movedName).not.toContain('\\');
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
