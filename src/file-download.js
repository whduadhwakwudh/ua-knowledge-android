/**
 * 文件传输下载（电脑文件夹 → 手机）。
 *
 * 与 APK 下载同构：Filesystem 定位 → FileTransfer 流式下载（带进度）→
 * 保存到应用私有目录 downloads/ → FileOpener 交给系统查看。
 * 不做内容哈希校验（文件来自用户自建服务器、设备令牌保护，与 APK 安装
 * 的安全等级不同）；文件名经 sanitize 处理防止路径注入。
 *
 * 每个插件调用都是可注入的（getUriImpl / downloadImpl / openImpl），
 * 便于单测；downloadImpl 传 null 走 web fallback（fetch + blob）。
 */

import { Directory, Filesystem } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { FileOpener } from '@capacitor-community/file-opener';
import { sanitizeFilename } from './apk-download.js';

export class FileDownloadError extends Error {
  static HTTP = 'HTTP';
  static NETWORK = 'NETWORK';
  static IO = 'IO';

  constructor(code, message) {
    super(message);
    this.name = 'FileDownloadError';
    this.code = code;
  }
}

function fileUrl(apiBaseUrl, id) {
  return String(apiBaseUrl).replace(/\/+$/, '') + '/v1/files/' + encodeURIComponent(id);
}

async function defaultGetUri({ directory, path }) {
  return Filesystem.getUri({ directory, path });
}

async function defaultDownload({ url, path, headers, onProgress }) {
  let listener = null;
  if (typeof onProgress === 'function') {
    listener = await FileTransfer.addListener('progress', (info) => {
      onProgress({ percent: info.percent, bytesSent: info.bytesSent ?? 0, totalBytes: info.totalBytes ?? 0 });
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
        // 清理尽力而为。
      }
    }
  }
}

async function defaultOpen(options) {
  await FileOpener.open(options);
}

export async function downloadFile({
  entry,
  apiBaseUrl,
  token,
  fetchImpl = null,
  getUriImpl = defaultGetUri,
  downloadImpl = defaultDownload,
  openImpl = defaultOpen,
  onProgress = null,
}) {
  const fileName = sanitizeFilename(entry.name);
  const relativePath = `downloads/${fileName}`;
  const url = fileUrl(apiBaseUrl, entry.id);
  const authHeaders = { Authorization: `Bearer ${token}` };

  /* ── web fallback（downloadImpl: null，测试/浏览器） ─────────── */
  if (downloadImpl === null) {
    const fetcher = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    if (typeof fetcher !== 'function') {
      throw new FileDownloadError(FileDownloadError.NETWORK, 'no download transport available');
    }
    let res;
    try {
      res = await fetcher(url, { method: 'GET', headers: authHeaders });
    } catch {
      throw new FileDownloadError(FileDownloadError.NETWORK, 'download failed');
    }
    if (!res || !res.ok) {
      throw new FileDownloadError(FileDownloadError.HTTP, `download failed (HTTP ${res?.status ?? 'unknown'})`);
    }
    const blob = await res.blob();
    return { blob, fileName, size: blob.size };
  }

  /* ── native：getUri → FileTransfer 流式下载 → FileOpener ────── */
  const target = await getUriImpl({ directory: Directory.Data, path: relativePath });
  const uri = typeof target === 'string' ? target : target?.uri;
  const transfer = await downloadImpl({ url, path: uri, headers: authHeaders, onProgress });
  const finalUri = typeof transfer === 'string' ? transfer : transfer?.path ?? uri;
  await openImpl({ filePath: finalUri, contentType: 'application/octet-stream', openWithDefault: true });
  return { uri: finalUri, fileName };
}
