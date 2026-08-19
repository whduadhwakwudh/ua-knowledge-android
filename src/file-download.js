/**
 * 文件传输下载（电脑文件夹 → 手机）。
 *
 * 流程：Filesystem 定位 → FileTransfer 流式下载（带进度）→ 暂存到应用私有
 * 目录 downloads/ → 原生 UaFileStore 插件把文件**移入系统公共 Downloads 目录**
 * （API 29+ 走 MediaStore，API 24-28 走 WRITE_EXTERNAL_STORAGE 直接写公共目录）
 * → FileOpener 按扩展名对应的 MIME 交给系统打开。
 *
 * 因此下载完成后文件在「文件管理」的 Download 目录可见，可被其他应用打开；
 * 不做内容哈希校验（文件来自用户自建服务器、设备令牌保护，与 APK 安装的
 * 安全等级不同）；文件名经 sanitize 处理防止路径注入。
 *
 * 每个插件调用都是可注入的（getUriImpl / downloadImpl / moveImpl /
 * openImpl），便于单测；downloadImpl 传 null 走 web fallback（fetch + blob，
 * 无文件系统、无移动、无打开）。
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

/** 常见扩展名 → MIME 映射；未命中回退 application/octet-stream。 */
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.apk': 'application/vnd.android.package-archive',
  '.epub': 'application/epub+zip',
  '.html': 'text/html',
  '.htm': 'text/html',
};

/** 按文件名（或其扩展名）返回 MIME；无扩展名/未知回退 octet-stream。 */
export function mimeTypeFor(fileName) {
  const name = String(fileName ?? '');
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT[name.slice(dot).toLowerCase()] ?? 'application/octet-stream';
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

/**
 * 原生：把 app 私有 downloads/ 下的文件移入系统公共 Downloads。
 * 返回 content://（API 29+ MediaStore）或 file://（API 24-28）URI。
 */
async function defaultMove({ path, fileName, mimeType }) {
  const { Capacitor } = await import('@capacitor/core');
  const plugin = Capacitor.Plugins && Capacitor.Plugins.UaFileStore;
  if (!plugin || typeof plugin.moveToDownloads !== 'function') {
    throw new FileDownloadError(FileDownloadError.IO, 'native file store plugin unavailable');
  }
  const result = await plugin.moveToDownloads({ path, fileName, mimeType });
  const uri = typeof result?.uri === 'string' ? result.uri : '';
  if (!uri) {
    throw new FileDownloadError(FileDownloadError.IO, 'move to downloads failed');
  }
  return { uri };
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
  moveImpl = defaultMove,
  openImpl = defaultOpen,
  onProgress = null,
}) {
  const fileName = sanitizeFilename(entry.name);
  const relativePath = `downloads/${fileName}`;
  const url = fileUrl(apiBaseUrl, entry.id);
  const authHeaders = { Authorization: `Bearer ${token}` };
  const mimeType = mimeTypeFor(fileName);

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

  /* ── native：getUri → FileTransfer 流式下载 → 移入公共 Downloads → 打开 ── */
  const target = await getUriImpl({ directory: Directory.Data, path: relativePath });
  const uri = typeof target === 'string' ? target : target?.uri;
  const transfer = await downloadImpl({ url, path: uri, headers: authHeaders, onProgress });
  const finalUri = typeof transfer === 'string' ? transfer : transfer?.path ?? uri;

  const moved = await moveImpl({ path: finalUri, fileName, mimeType });
  const publicUri = typeof moved === 'string' ? moved : moved?.uri ?? finalUri;

  await openImpl({ filePath: publicUri, contentType: mimeType, openWithDefault: true });
  return { uri: publicUri, fileName, mimeType };
}
