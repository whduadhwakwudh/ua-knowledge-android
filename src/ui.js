/**
 * UI wiring (Task 7) — pure DOM rendering + event binding for the UA knowledge
 * app, testable in jsdom with no Capacitor involvement.
 *
 * mountApp(container, wiring) binds the REAL shell markup (www/index.html) that
 * must already live inside `container` (the .screen element in production; a
 * jsdom window built from the same file in tests). All queries are scoped to
 * `container.ownerDocument`, so the module never touches globals.
 *
 * State contract (main.js feeds this via ui.update()):
 *   connection:   'unconfigured' | 'connected' | 'auth-error'
 *   baseUrl:      string|null
 *   tokenPresent: boolean        — token itself NEVER enters the state
 *   syncing, syncPhase ('manifest'|'download'|'verify'|'commit'|'complete'|null),
 *   syncCounts ({total, downloaded, verified, added, updated, removed, unchanged}),
 *   lastSyncAt, activeRevision, syncError,
 *   query, documents[], artifacts[], favorites[] (ids), detail|null, tab
 *
 * Security invariants enforced here:
 * - the device token is only ever held by the masked password input while the
 *   user types it; it is never written into any other element or attr;
 * - all server-derived text is HTML-escaped before innerHTML insertion
 *   (markdown bodies arrive pre-sanitized via renderMarkdown).
 */

import { normalizeBaseUrl, validateToken } from './connection-store.js';

const HIDDEN = 'hidden';
const STAR_PATH = 'M12 3.6l2.56 5.2 5.73.83-4.14 4.04.98 5.7L12 16.72l-5.13 2.7.98-5.7L3.7 9.63l5.73-.83L12 3.6z';
const THEME_LABEL = { light: '浅色', dark: '深色', system: '跟随系统' };

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toggleHidden(el, hidden) {
  if (el) el.classList.toggle(HIDDEN, !!hidden);
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function todayGreeting() {
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date());
  } catch {
    return '';
  }
}

export function mountApp(container, wiring = {}) {
  const doc = container.ownerDocument;
  const $ = (selector) => container.querySelector(selector);
  const $$ = (selector) => Array.from(container.querySelectorAll(selector));
  const screen = container;
  const viewport = doc.defaultView;

  let state = {};
  let toastTimer = null;
  let lastFocus = null;
  let currentDetailId = null;

  /* ─── toast ─────────────────────────────────────────────── */
  function toast(message, ms = 2400) {
    const el = $('#toast');
    if (!el) return;
    el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7.5"/></svg>' + esc(message);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = viewport.setTimeout(() => el.classList.remove('show'), ms);
    el.onmouseenter = () => clearTimeout(toastTimer);
    el.onmouseleave = () => {
      toastTimer = viewport.setTimeout(() => el.classList.remove('show'), ms);
    };
  }

  /* ─── sheets ────────────────────────────────────────────── */
  function openSheet(id) {
    lastFocus = doc.activeElement;
    $$('.sheet').forEach((s) => s.classList.remove('open'));
    const sheet = $('#' + id);
    if (!sheet) return;
    sheet.classList.add('open');
    const layer = $('#sheet-layer');
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
    // Only focus a real text input/textarea. Focusing a plain button or an
    // option row scrolls the page to that element in some WebViews (the
    // "sheet opens but the page jumps up" bug), so skip non-input targets.
    const inputTarget = sheet.querySelector('input, textarea');
    if (inputTarget) inputTarget.focus();
  }

  function closeSheets() {
    const layer = $('#sheet-layer');
    if (!layer) return;
    layer.classList.remove('open');
    layer.setAttribute('aria-hidden', 'true');
    $$('.sheet').forEach((s) => s.classList.remove('open'));
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function openConnectionSheet() {
    openSheet('sheet-connection');
    if ($('#conn-base-url')) {
      // The base URL is not a secret and may be prefilled; the token never is.
      $('#conn-base-url').value = state.baseUrl ?? '';
      $('#conn-token').value = '';
    }
    if ($('#conn-storage-warning')) {
      $('#conn-storage-warning').textContent = state.storageWarning ?? '';
      toggleHidden($('#conn-storage-warning'), !state.storageWarning);
    }
    setConnectionStatus('');
  }

  /* ─── connection form helpers ───────────────────────────── */
  function setConnectionBusy(busy) {
    const testBtn = $('#conn-test');
    const saveBtn = $('#conn-save');
    if (testBtn) {
      testBtn.disabled = busy;
      testBtn.textContent = busy ? '测试中…' : '测试连接';
    }
    if (saveBtn) {
      saveBtn.disabled = busy;
      saveBtn.textContent = busy ? '保存中…' : '保存';
    }
  }

  function setConnectionStatus(text, _kind) {
    const el = $('#conn-status');
    if (el) el.textContent = text ?? '';
  }

  function showConnectionErrors(errors = {}) {
    const fields = { baseUrl: $('#conn-base-url'), token: $('#conn-token') };
    const errEls = { baseUrl: $('#conn-base-url-err'), token: $('#conn-token-err') };
    for (const key of ['baseUrl', 'token']) {
      const message = errors[key];
      if (errEls[key]) {
        errEls[key].textContent = message ?? '';
        toggleHidden(errEls[key], !message);
      }
      if (fields[key]) fields[key].classList.toggle('invalid', !!message);
    }
  }

  function submitConnection(action) {
    const baseUrl = ($('#conn-base-url')?.value ?? '').trim();
    const token = $('#conn-token')?.value ?? '';
    const errors = {};
    if (!baseUrl) {
      errors.baseUrl = '服务器地址不能为空';
    } else {
      const urlResult = normalizeBaseUrl(baseUrl);
      if (!urlResult.ok) errors.baseUrl = '服务器地址格式不正确';
    }
    if (token !== '') {
      if (!validateToken(token).ok) errors.token = '设备令牌格式不正确';
    } else if (!state.tokenPresent) {
      errors.token = '设备令牌不能为空';
    }
    if (Object.keys(errors).length > 0) {
      showConnectionErrors(errors);
      return;
    }
    showConnectionErrors({});
    wiring.onConnectionChange?.({ action, baseUrl, token });
  }

  /* ─── theme ─────────────────────────────────────────────── */
  function applyTheme(value) {
    const dark = value === 'dark' || (value === 'system' && viewport?.matchMedia?.('(prefers-color-scheme: dark)')?.matches);
    screen.dataset.theme = dark ? 'dark' : 'light';
    if ($('#set-appearance-sub')) $('#set-appearance-sub').textContent = THEME_LABEL[value] ?? value;
    $$('#sheet-appearance .option-row').forEach((row) => {
      row.classList.toggle('checked', row.dataset.value === value);
    });
    try {
      const storage = viewport.localStorage;
      if (storage) storage.setItem('ua-theme', value);
    } catch {
      // Theme persistence is best-effort only.
    }
  }

  /* ─── rendering fragments ───────────────────────────────── */
  function noteCardHtml(d) {
    return (
      '<article class="note-card" data-open="' +
      esc(d.id) +
      '" role="button" tabindex="0" aria-label="打开笔记：' +
      esc(d.title) +
      '">' +
      '<h3 class="note-title">' +
      esc(d.title) +
      '</h3>' +
      '<p class="note-excerpt">' +
      esc(d.excerpt ?? '') +
      '</p>' +
      '<div class="note-foot"><div class="chips"><span class="chip chip-mono">' +
      esc(d.label ?? '') +
      '</span></div><span class="note-time">' +
      esc(d.updated ?? '') +
      '</span></div>' +
      '</article>'
    );
  }

  function favRowHtml(d) {
    const isFav = state.favorites.includes(d.id);
    const on = isFav ? ' on' : '';
    return (
      '<div class="list-row">' +
      '<div class="body" data-open="' +
      esc(d.id) +
      '" role="button" tabindex="0" aria-label="打开笔记：' +
      esc(d.title) +
      '">' +
      '<div class="title">' +
      esc(d.title) +
      '</div><div class="sub">' +
      esc(d.excerpt ?? '') +
      '</div></div>' +
      '<button class="star-btn' +
      on +
      '" data-toggle-fav="' +
      esc(d.id) +
      '" aria-pressed="' +
      (isFav ? 'true' : 'false') +
      '" aria-label="' +
      (isFav ? '取消收藏' : '收藏') +
      '：' +
      esc(d.title) +
      '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' +
      STAR_PATH +
      '"/></svg></button>' +
      '</div>'
    );
  }

  function artifactRowHtml(a) {
    const meta = [formatSize(a.size), '校验 ' + String(a.sha256 ?? '').slice(0, 8)].filter(Boolean).join(' · ');
    return (
      '<div class="list-row">' +
      '<div class="body">' +
      '<div class="title">' +
      esc(a.title) +
      '</div><div class="sub">' +
      esc(meta) +
      '</div></div>' +
      '<button class="btn-primary" data-download-id="' +
      esc(a.id) +
      '" style="min-height:36px;padding:8px 12px;font-size:13px;border-radius:10px;">下载</button>' +
      '</div>'
    );
  }

  /* ─── rendering: home ───────────────────────────────────── */
  function renderHome(state) {
    const query = (state.query ?? '').trim();
    const documents = state.documents ?? [];
    const noDocs = documents.length === 0;

    if ($('#home-greeting')) {
      const g = todayGreeting();
      if (g) $('#home-greeting').textContent = g + ' · 离线可用';
    }

    // unconfigured/empty → setup prompt replaces the summary card
    const showPrompt = state.connection === 'unconfigured' && noDocs;
    toggleHidden($('#connect-prompt-wrap'), !showPrompt);
    toggleHidden($('#sync-card'), showPrompt);
    toggleHidden($('#auth-error-wrap'), state.connection !== 'auth-error');

    if ($('#recent-count')) $('#recent-count').textContent = documents.length + ' 篇';

    const searching = query !== '';
    toggleHidden($('#search-head'), !searching);
    if ($('#sh-count')) $('#sh-count').textContent = documents.length + ' 篇';

    if ($('#recent-list')) {
      $('#recent-list').innerHTML = documents.map(noteCardHtml).join('');
    }

    if (searching) {
      toggleHidden($('#search-empty'), documents.length > 0);
      if ($('#search-empty-q')) $('#search-empty-q').textContent = query;
      toggleHidden($('#recent-empty'), true);
    } else {
      toggleHidden($('#search-empty'), true);
      toggleHidden($('#recent-empty'), !(noDocs && state.connection !== 'unconfigured'));
    }
  }

  function renderSyncCard(state) {
    const statusEl = $('#sync-status-text');
    const countEl = $('#sync-count-text');
    const syncBtn = $('#btn-sync');
    if (!statusEl) return;

    let status = '';
    let count = '';
    if (state.syncing) {
      const counts = state.syncCounts ?? {};
      switch (state.syncPhase) {
        case 'manifest':
          status = '正在同步 · 获取目录';
          count = '共 ' + (counts.total ?? 0) + ' 个条目';
          break;
        case 'download':
          status = '正在同步 · 下载文档';
          count = (counts.downloaded ?? 0) + ' 篇';
          break;
        case 'verify':
          status = '正在同步 · 校验内容';
          count = (counts.verified ?? 0) + ' 篇';
          break;
        case 'commit':
          status = '正在同步 · 写入本地缓存';
          break;
        default:
          status = '正在同步 · 准备中';
      }
    } else if (state.syncError) {
      status = '同步失败 · ' + state.syncError;
      count = '显示本地缓存';
    } else if (state.syncPhase === 'complete' && state.syncCounts) {
      const { added = 0, updated = 0, removed = 0, unchanged = 0 } = state.syncCounts;
      if (added === 0 && updated === 0 && removed === 0) {
        status = '已是最新';
      } else {
        status = '同步完成';
        count = `新增 ${added} · 更新 ${updated} · 移除 ${removed} · 未变 ${unchanged}`;
      }
    } else if (state.lastSyncAt) {
      status = '已同步 · ' + formatTime(state.lastSyncAt);
    } else {
      status = '尚未同步';
      count = '连接设备后即可拉取内容';
    }
    statusEl.textContent = status;
    if (countEl) countEl.textContent = count;
    if (syncBtn) syncBtn.disabled = !!state.syncing;
  }

  function renderArtifacts(state) {
    const list = state.artifacts ?? [];
    toggleHidden($('#artifacts-section'), list.length === 0);
    if ($('#artifacts-count')) $('#artifacts-count').textContent = list.length + ' 个';
    if ($('#artifacts-list')) $('#artifacts-list').innerHTML = list.map(artifactRowHtml).join('');
    toggleHidden($('#artifacts-empty'), list.length !== 0);
  }

  /* ─── rendering: favorites ──────────────────────────────── */
  function renderFavs(state) {
    const favorites = state.favorites ?? [];
    const favDocs = (state.documents ?? []).filter((d) => favorites.includes(d.id));
    if ($('#fav-count')) $('#fav-count').textContent = favDocs.length + ' 篇';
    const groups = $('#fav-groups');
    if (groups) groups.innerHTML = favDocs.length
      ? '<div class="grouped fav-group">' + favDocs.map(favRowHtml).join('') + '</div>'
      : '';
    toggleHidden($('#fav-groups'), favDocs.length === 0);
    toggleHidden($('#fav-empty-wrap'), favDocs.length !== 0);
    toggleHidden($('#fav-empty'), favDocs.length !== 0);
  }

  /* ─── rendering: me ─────────────────────────────────────── */
  function renderMe(state) {
    const documents = state.documents ?? [];
    const dirs = new Set();
    for (const d of documents) {
      const slash = d.relativePath ? d.relativePath.indexOf('/') : -1;
      dirs.add(slash > 0 ? d.relativePath.slice(0, slash) : (d.relativePath ?? ''));
    }
    if ($('#stat-notes')) $('#stat-notes').textContent = documents.length;
    if ($('#stat-sources')) $('#stat-sources').textContent = dirs.size;
    if ($('#stat-favs')) $('#stat-favs').textContent = (state.favorites ?? []).length;
    if ($('#set-sync-sub')) {
      $('#set-sync-sub').textContent = state.lastSyncAt ? '已同步 · ' + formatTime(state.lastSyncAt) : '未同步';
    }
    if ($('#set-connection-sub')) {
      $('#set-connection-sub').textContent =
        state.connection === 'unconfigured' ? '未连接' : state.baseUrl ?? '已连接';
    }
  }

  /* ─── rendering: detail ─────────────────────────────────── */
  function renderDetail(state) {
    const detail = state.detail;
    if (!detail) {
      screen.classList.remove('detail-open');
      if ($('#view-detail')) $('#view-detail').setAttribute('aria-hidden', 'true');
      currentDetailId = null;
      return;
    }
    currentDetailId = detail.id;
    if ($('#detail-title')) $('#detail-title').textContent = detail.title;
    if ($('#detail-chips')) {
      $('#detail-chips').innerHTML = (detail.chips ?? [])
        .map((chip) => '<span class="chip">' + esc(chip) + '</span>')
        .join('');
    }
    if ($('#detail-body')) $('#detail-body').innerHTML = detail.html ?? '';
    const star = $('#detail-star');
    if (star) {
      const on = (state.favorites ?? []).includes(detail.id);
      star.classList.toggle('on', on);
      star.setAttribute('aria-pressed', String(on));
      star.setAttribute('aria-label', on ? '取消收藏' : '收藏');
    }
    screen.classList.add('detail-open');
    if ($('#view-detail')) $('#view-detail').setAttribute('aria-hidden', 'false');
    if ($('#detail-scroll')) $('#detail-scroll').scrollTop = 0;
  }

  /* ─── tab navigation ────────────────────────────────────── */
  function applyTab(name) {
    $$('.view').forEach((v) => {
      const active = v.id === 'view-' + name;
      v.classList.toggle('active', active);
      v.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
    $$('.tab').forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('active', active);
      if (active) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
  }

  function goTab(name) {
    applyTab(name);
    wiring.onSelectTab?.(name);
  }

  function closeDetail() {
    screen.classList.remove('detail-open');
    if ($('#view-detail')) $('#view-detail').setAttribute('aria-hidden', 'true');
    if (currentDetailId) wiring.onCloseDetail?.(currentDetailId);
    currentDetailId = null;
  }

  /* ─── full render ───────────────────────────────────────── */
  function update(nextState) {
    state = nextState ?? {};
    renderHome(state);
    renderSyncCard(state);
    renderArtifacts(state);
    renderFavs(state);
    renderMe(state);
    renderDetail(state);
    applyTab(state.tab ?? 'home');
  }

  /* ═══ event binding (once) ════════════════════════════════ */
  const searchInput = $('#search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const value = e.target.value;
      toggleHidden($('#search-clear'), value === '');
      wiring.onQueryChange?.(value);
    });
  }
  const clearSearch = () => {
    if (searchInput) searchInput.value = '';
    toggleHidden($('#search-clear'), true);
    wiring.onQueryChange?.('');
  };
  $('#search-clear')?.addEventListener('click', clearSearch);
  $('#search-clear2')?.addEventListener('click', clearSearch);

  $$('.tab').forEach((t) => t.addEventListener('click', () => goTab(t.dataset.tab)));
  $('#btn-to-profile')?.addEventListener('click', () => goTab('me'));
  $('#btn-go-home')?.addEventListener('click', () => goTab('home'));

  $('#btn-sync')?.addEventListener('click', () => wiring.onSync?.());
  $('#btn-recent-sync')?.addEventListener('click', () => wiring.onSync?.());
  $('#setting-sync')?.addEventListener('click', () => wiring.onSync?.());
  $('#btn-auth-retry')?.addEventListener('click', () => wiring.onSync?.());

  $('#btn-open-connection')?.addEventListener('click', () => {
    openConnectionSheet();
    wiring.onConnectionChange?.({ action: 'open' });
  });
  $('#btn-conn-settings')?.addEventListener('click', () => {
    openConnectionSheet();
    wiring.onConnectionChange?.({ action: 'open' });
  });
  $('#setting-connection')?.addEventListener('click', () => {
    openConnectionSheet();
    wiring.onConnectionChange?.({ action: 'open' });
  });

  $('#setting-appearance')?.addEventListener('click', () => openSheet('sheet-appearance'));
  $$('#sheet-appearance .option-row').forEach((row) => {
    row.addEventListener('click', () => {
      applyTheme(row.dataset.value);
      closeSheets();
    });
  });
  $('#setting-about')?.addEventListener('click', () => openSheet('sheet-about'));
  $('#about-done')?.addEventListener('click', closeSheets);

  $('#conn-test')?.addEventListener('click', () => submitConnection('test'));
  $('#conn-save')?.addEventListener('click', () => submitConnection('save'));
  $('#conn-clear')?.addEventListener('click', () => wiring.onConnectionChange?.({ action: 'clear' }));
  $('#conn-base-url')?.addEventListener('input', () =>
    showConnectionErrors({ baseUrl: '', token: currentTokenError() }),
  );
  $('#conn-token')?.addEventListener('input', () =>
    showConnectionErrors({ baseUrl: currentBaseUrlError(), token: '' }),
  );

  function currentBaseUrlError() {
    const el = $('#conn-base-url-err');
    return el && !el.classList.contains(HIDDEN) ? el.textContent : '';
  }
  function currentTokenError() {
    const el = $('#conn-token-err');
    return el && !el.classList.contains(HIDDEN) ? el.textContent : '';
  }

  $('#detail-back')?.addEventListener('click', closeDetail);
  $('#detail-star')?.addEventListener('click', () => {
    if (currentDetailId) wiring.onToggleFavorite?.(currentDetailId);
  });
  $('#scrim')?.addEventListener('click', closeSheets);

  container.addEventListener('click', (e) => {
    const download = e.target.closest('[data-download-id]');
    if (download) {
      wiring.onDownloadArtifact?.(download.dataset.downloadId);
      return;
    }
    const fav = e.target.closest('[data-toggle-fav]');
    if (fav) {
      wiring.onToggleFavorite?.(fav.dataset.toggleFav);
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      if ($('#sheet-layer')?.classList.contains('open')) closeSheets();
      wiring.onOpenDocument?.(open.dataset.open);
    }
  });

  container.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#sheet-layer')?.classList.contains('open')) closeSheets();
      else if (screen.classList.contains('detail-open')) closeDetail();
      return;
    }
    const open = e.target.closest?.('[data-open]');
    if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      wiring.onOpenDocument?.(open.dataset.open);
    }
  });

  /* ─── theme init ────────────────────────────────────────── */
  let savedTheme = 'light';
  try {
    savedTheme = viewport.localStorage?.getItem('ua-theme') ?? 'light';
  } catch {
    // ignore
  }
  applyTheme(['light', 'dark', 'system'].includes(savedTheme) ? savedTheme : 'light');

  return {
    update,
    toast,
    openConnectionSheet,
    closeSheets,
    setConnectionBusy,
    setConnectionStatus,
    showConnectionErrors,
  };
}