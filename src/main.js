/**
 * UA knowledge base mobile app — web entry module (Tasks 7 + 8).
 *
 * Bootstraps the production stack — secure connection store, authenticated API
 * client, IndexedDB cache, sync engine, favorites and local search index — and
 * wires them into the DOM shell via src/ui.js (mountApp).
 *
 * Import-safety contract (enforced by test/bootstrap.test.js):
 * - importing this module performs no network, storage or credential action;
 * - createAppState() keeps its exact baseline shape;
 * - the module source contains no HTTP-fetch, XHR, web-storage, or credential
 *   literals (the authenticated API client and the APK downloader own those).
 *
 * Browser entry: when this bundle runs inside the Capacitor WebView (i.e. the
 * DOM shell from www/index.html is present), bootstrapApp() runs automatically.
 */

import { createProductionConnectionStore } from './connection-store.js';
import { createApiClient, ApiError } from './api-client.js';
import { openKnowledgeDb } from './cache-db.js';
import { createSyncEngine } from './sync-engine.js';
import { renderMarkdown } from './markdown.js';
import { buildSearchIndex } from './search-index.js';
import { createFavoritesStore } from './favorites.js';
import { mountApp } from './ui.js';
import { downloadAndVerifyApk } from './apk-download.js';

export function createAppState() {
  return {
    tab: 'home',
    query: '',
    syncing: false,
    activeRevision: null,
    connection: 'unconfigured',
    documents: [],
    artifacts: [],
  };
}

function blankRuntimeState() {
  return {
    tab: 'home',
    query: '',
    syncing: false,
    activeRevision: null,
    connection: 'unconfigured',
    documents: [],
    artifacts: [],
    baseUrl: null,
    tokenPresent: false,
    token: null,
    storageWarning: null,
    syncPhase: null,
    syncCounts: null,
    lastSyncAt: null,
    syncError: null,
    favorites: [],
    detail: null,
  };
}

function excerptOf(text) {
  if (!text) return '';
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const cleaned = line.replace(/^#+\s*/, '').replace(/[*_`>[\]]/g, '');
  return cleaned.length > 58 ? cleaned.slice(0, 58) + '…' : cleaned;
}

function topDirOf(relativePath) {
  const slash = relativePath.indexOf('/');
  return slash > 0 ? relativePath.slice(0, slash) : relativePath;
}

function humanDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleDateString('zh-CN');
}

function friendlySize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function connectionErrorText(err) {
  switch (err && err.code) {
    case ApiError.NETWORK:
      return '无法连接服务器，请检查网络';
    case ApiError.UNAUTHORIZED:
      return '认证失败，请检查设备令牌';
    case ApiError.RATE_LIMITED:
      return '请求过于频繁，请稍后重试';
    case ApiError.INTEGRITY:
      return '服务器响应数据异常';
    case ApiError.SCHEMA:
      return '服务器响应格式异常';
    case ApiError.SERVER:
      return '服务器错误，请稍后重试';
    case ApiError.REQUEST:
      return '请求被服务器拒绝';
    case ApiError.NOT_FOUND:
      return '接口不存在，请检查服务器地址';
    default:
      return '连接失败';
  }
}

function defaultContainer() {
  if (typeof document === 'undefined') throw new Error('bootstrapApp requires a DOM container');
  return document.getElementById('screen') ?? document.body;
}

export async function bootstrapApp(options = {}) {
  const {
    container = defaultContainer(),
    isNative,
    connectionStoreImpl,
    dbImpl,
    fetchImpl,
    apiTimeoutMs,
  } = options;
  const connectionStore = connectionStoreImpl ?? (await createProductionConnectionStore({ isNative }));
  const db = dbImpl ?? (await openKnowledgeDb());
  const favoritesStore = createFavoritesStore(db);
  let stored;
  try {
    stored = await connectionStore.load();
  } catch {
    // Secure-storage read failed (keystore unavailable/corrupt). Keep the app
    // usable: no saved connection, empty state, prompt to configure.
    stored = { configured: false, baseUrl: null, tokenPresent: false, token: null };
  }

  const state = blankRuntimeState();
  state.baseUrl = stored.baseUrl;
  state.tokenPresent = stored.tokenPresent;
  state.token = stored.token;
  state.connection = stored.configured ? 'connected' : 'unconfigured';
  state.storageWarning = connectionStore.storageWarning ?? null;

  let api = null;
  let engine = null;
  let search = null;
  let allDocuments = [];
  let allArtifacts = [];
  let docById = new Map();
  let artifactById = new Map();

  /* ─── content loading ───────────────────────────────────── */
  async function refreshCachedContent() {
    state.activeRevision = await db.getActiveRevision();
    const manifest = await db.getActiveManifest();
    const docs = [];
    const arts = [];
    const nextDocById = new Map();
    const nextArtifactById = new Map();
    for (const entry of manifest?.entries ?? []) {
      if (entry.kind === 'document') {
        const text = await db.getDocumentText(entry.sha256);
        const doc = {
          id: entry.id,
          title: entry.title,
          excerpt: excerptOf(text),
          label: topDirOf(entry.relativePath),
          updated: humanDate(entry.mtime),
          relativePath: entry.relativePath,
          sha256: entry.sha256,
          mtime: entry.mtime,
          size: entry.size,
          text,
        };
        docs.push(doc);
        nextDocById.set(doc.id, doc);
      } else {
        const art = {
          id: entry.id,
          title: entry.title,
          relativePath: entry.relativePath,
          sha256: entry.sha256,
          mtime: entry.mtime,
          size: entry.size,
        };
        arts.push(art);
        nextArtifactById.set(art.id, art);
      }
    }
    allDocuments = docs;
    allArtifacts = arts;
    docById = nextDocById;
    artifactById = nextArtifactById;
    const favoriteRecords = await favoritesStore.list();
    state.favorites = favoriteRecords.map((f) => f.documentId);
    search = buildSearchIndex(
      docs.map((d) => ({ id: d.id, title: d.title, body: d.text ?? '', relativePath: d.relativePath })),
    );
    state.documents = state.query.trim() ? applySearch(state.query) : docs;
    state.artifacts = arts;
  }

  function applySearch(query) {
    if (!search) return [];
    return search
      .query(query)
      .map((hit) => docById.get(hit.id))
      .filter(Boolean);
  }

  async function rebuildApi(baseUrl, token) {
    api = createApiClient({ baseUrl, token, fetchImpl, timeoutMs: apiTimeoutMs });
    engine = createSyncEngine({ api, db });
    await refreshCachedContent();
  }

  /* ─── sync ──────────────────────────────────────────────── */
  async function runSync() {
    if (state.syncing) return;
    if (!engine || !api) {
      // Connection settings were saved but the API client/engine failed to
      // rebuild (e.g. token missing in secure storage, or restore threw).
      // Never fail silently: tell the user and open the connection sheet.
      ui.toast('请先完成连接设置');
      ui.openConnectionSheet();
      return;
    }
    state.syncing = true;
    state.syncError = null;
    state.syncPhase = null;
    state.syncCounts = null;
    ui.update(state);
    try {
      const result = await engine.sync({
        onPhase(event) {
          state.syncPhase = event.phase;
          const { phase, revision, ...rest } = event;
          state.syncCounts = { ...(state.syncCounts ?? {}), ...rest };
          ui.update(state);
        },
      });
      state.syncPhase = 'complete';
      state.syncCounts = {
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        unchanged: result.unchanged,
      };
      state.lastSyncAt = new Date().toISOString();
      if (state.connection === 'auth-error') state.connection = 'connected';
      await refreshCachedContent();
    } catch (err) {
      if (err && err.code === ApiError.UNAUTHORIZED) {
        state.connection = 'auth-error';
        state.syncError = '认证失败，请检查设备令牌';
      } else if (err && err.code === ApiError.NETWORK) {
        state.syncError = '网络不可达，显示本地缓存';
      } else if (err && err.code === ApiError.RATE_LIMITED) {
        state.syncError = '请求过于频繁，请稍后重试';
      } else if (err && (err.code === ApiError.SCHEMA || err.code === ApiError.INTEGRITY)) {
        state.syncError = '数据校验失败，已保留原有缓存';
      } else {
        state.syncError = '同步失败';
      }
    } finally {
      state.syncing = false;
      ui.update(state);
    }
  }

  /* ─── document + favorites ──────────────────────────────── */
  async function openDocument(id) {
    const doc = docById.get(id);
    if (!doc) return;
    let html;
    try {
      const text = await db.getDocumentText(doc.sha256);
      html = renderMarkdown(text ?? '');
    } catch {
      html = '<p>内容读取失败，请重新同步后再试。</p>';
    }
    state.detail = {
      id: doc.id,
      title: doc.title,
      chips: [doc.label, '更新于 ' + doc.updated, friendlySize(doc.size)],
      html,
    };
    ui.update(state);
  }

  async function toggleFavorite(id) {
    const now = await favoritesStore.toggle(id);
    const set = new Set(state.favorites);
    if (now) set.add(id);
    else set.delete(id);
    state.favorites = Array.from(set);
    ui.toast(now ? '已收藏' : '已取消收藏');
    ui.update(state);
  }

  /* ─── connection sheet ──────────────────────────────────── */
  async function testConnection(baseUrl, token) {
    ui.setConnectionBusy(true);
    try {
      const candidate = createApiClient({ baseUrl: baseUrl || state.baseUrl, token: token || state.token });
      await candidate.health();
      ui.setConnectionStatus('连接成功', 'success');
    } catch (err) {
      ui.setConnectionStatus(connectionErrorText(err), 'error');
    } finally {
      ui.setConnectionBusy(false);
    }
  }

  async function saveConnection(baseUrl, token) {
    const url = baseUrl || state.baseUrl;
    const tok = token || state.token;
    ui.setConnectionBusy(true);
    try {
      await connectionStore.save({ baseUrl: url, token: tok });
      state.baseUrl = url;
      state.token = tok;
      state.tokenPresent = true;
      state.connection = 'connected';
      await rebuildApi(url, tok);
      ui.closeSheets();
      ui.update(state);
      runSync();
    } catch {
      ui.setConnectionStatus('保存失败：连接设置无效或存储不可用', 'error');
      ui.setConnectionBusy(false);
    }
  }

  async function clearConnection() {
    ui.setConnectionBusy(true);
    try {
      await connectionStore.clear();
    } catch {
      ui.setConnectionStatus('清除失败，请重试', 'error');
      ui.setConnectionBusy(false);
      return;
    }
    state.baseUrl = null;
    state.token = null;
    state.tokenPresent = false;
    state.connection = 'unconfigured';
    state.syncError = null;
    state.syncPhase = null;
    state.syncCounts = null;
    state.lastSyncAt = null;
    state.activeRevision = null;
    state.documents = [];
    state.artifacts = [];
    state.favorites = [];
    state.detail = null;
    allDocuments = [];
    allArtifacts = [];
    docById = new Map();
    artifactById = new Map();
    search = null;
    api = null;
    engine = null;
    ui.closeSheets();
    ui.setConnectionStatus('已清除连接设置');
    ui.setConnectionBusy(false);
    ui.update(state);
  }

  async function handleConnectionChange(payload) {
    if (payload.action === 'test') {
      await testConnection(payload.baseUrl, payload.token);
    } else if (payload.action === 'save') {
      await saveConnection(payload.baseUrl, payload.token);
    } else if (payload.action === 'clear') {
      await clearConnection();
    }
    // 'open' — the sheet is already open; nothing else to do.
  }

  /* ─── artifacts (Task 8 download hook) ──────────────────── */
  async function downloadArtifact(id) {
    const entry = artifactById.get(id);
    if (!entry || !state.baseUrl || !state.token) {
      ui.toast('请先完成连接设置');
      return;
    }
    ui.toast('开始下载…');
    try {
      await downloadAndVerifyApk({
        entry,
        apiBaseUrl: state.baseUrl,
        token: state.token,
        onProgress: () => {
          // Progress updates surface through the toast; Android throttles
          // progress events to 100ms so this is lightweight.
        },
      });
      ui.toast('下载完成，请在弹出的系统安装确认中点击「安装」；首次使用需在系统设置允许「安装未知应用」');
    } catch (err) {
      if (err && err.code === 'HASH_MISMATCH') {
        ui.toast('校验失败，已删除文件');
      } else if (err && err.code === ApiError.UNAUTHORIZED) {
        state.connection = 'auth-error';
        ui.update(state);
        ui.toast('认证失败，请重新连接');
      } else {
        ui.toast('下载失败，请稍后重试');
      }
    }
  }

  /* ─── mount ─────────────────────────────────────────────── */
  const ui = mountApp(container, {
    onSync: () => {
      runSync();
    },
    onOpenDocument: (id) => {
      openDocument(id);
    },
    onToggleFavorite: (id) => {
      toggleFavorite(id);
    },
    onQueryChange: (query) => {
      state.query = query;
      state.documents = query.trim() ? applySearch(query) : allDocuments;
      ui.update(state);
    },
    onConnectionChange: (payload) => {
      handleConnectionChange(payload);
    },
    onDownloadArtifact: (id) => {
      downloadArtifact(id);
    },
    onSelectTab: (tab) => {
      state.tab = tab;
      state.detail = null;
    },
    onCloseDetail: () => {
      state.detail = null;
    },
  });

  ui.update(state);
  if (stored.configured) {
    try {
      await rebuildApi(stored.baseUrl, stored.token);
    } catch {
      // Saved settings could not be rebuilt (missing/invalid token in secure
      // storage, or adapter failure). Keep the app usable: fall back to the
      // unconfigured prompt instead of leaving a dead sync button.
      state.connection = 'unconfigured';
      state.syncError = '连接设置已失效，请重新配置';
    }
    ui.update(state);
  }

  /* ─── Android hardware back: sheet → detail → exit ─────────── */
  if (typeof Capacitor !== 'undefined' && Capacitor.getPlatform?.() !== 'web') {
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', () => {
      if (ui.isSheetOpen()) {
        // Close the open sheet first; keep the app foregrounded.
        ui.closeSheets();
        return;
      }
      if (state.detail) {
        state.detail = null;
        ui.update(state);
        return;
      }
      // Top level: let the platform default exit the app.
    });
  }

  return {
    ui,
    state,
    runSync,
    refreshCachedContent,
    rebuildApi,
  };
}

/* ─── browser entry: run only when the real shell is present ── */
if (
  typeof document !== 'undefined' &&
  typeof document.getElementById === 'function' &&
  document.getElementById('screen')
) {
  bootstrapApp({ container: document.getElementById('screen') });
}