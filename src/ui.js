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

import { normalizeBaseUrl, validateToken, validateLlmApiKey } from './connection-store.js';
import { renderMarkdown } from './markdown.js';

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

/** 阅读缩放系数钳制范围（0.7×–2.5×），非法输入回退 1。 */
export function clampReadScale(value, min = 0.7, max = 2.5) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, value));
}

/** 两指触摸距离（px）；不足两指返回 0。 */
function touchDistance(touches) {
  if (!touches || touches.length < 2) return 0;
  const a = touches[0];
  const b = touches[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
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

  /** True when any bottom sheet is currently open (Android back handling). */
  function isSheetOpen() {
    const layer = $('#sheet-layer');
    return !!layer && layer.classList.contains('open');
  }

  function openConnectionSheet() {
    openSheet('sheet-connection');
    if ($('#conn-base-url')) {
      // The base URL is not a secret and may be prefilled; the token never is.
      $('#conn-base-url').value = state.baseUrl ?? '';
      $('#conn-token').value = '';
      // 助手 API Key 同样不回显（敏感凭据）。
      $('#conn-llm-key').value = '';
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
    const fields = { baseUrl: $('#conn-base-url'), token: $('#conn-token'), llmKey: $('#conn-llm-key') };
    const errEls = { baseUrl: $('#conn-base-url-err'), token: $('#conn-token-err'), llmKey: $('#conn-llm-key-err') };
    for (const key of ['baseUrl', 'token', 'llmKey']) {
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
    const llmApiKey = $('#conn-llm-key')?.value ?? '';
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
    if (llmApiKey.trim() !== '') {
      const keyResult = validateLlmApiKey(llmApiKey);
      if (!keyResult.ok) errors.llmKey = keyResult.error;
    }
    if (Object.keys(errors).length > 0) {
      showConnectionErrors(errors);
      return;
    }
    showConnectionErrors({});
    // llmApiKey 空串 = 保持已保存值不变（与 token 语义一致）。
    wiring.onConnectionChange?.({ action, baseUrl, token, llmApiKey: llmApiKey.trim() });
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
      '<svg class="note-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/></svg>' +
      '<div class="note-body">' +
      '<h3 class="note-title">' +
      esc(d.title) +
      '</h3>' +
      '<p class="note-excerpt">' +
      esc(d.excerpt ?? '') +
      '</p>' +
      '</div>' +
      '<div class="note-right"><span class="note-label">' +
      esc(d.label ?? '') +
      '</span><span class="note-time">' +
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

  /* ─── sidebar（Obsidian 风格左侧文件树抽屉） ─────────────── */
  function renderSidebar(state) {
    const cats = state.categories ?? [];
    const allDocs = state.allDocuments ?? state.documents ?? [];
    const current = state.category ?? 'all';
    const counts = new Map();
    for (const d of allDocs) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
    const nav = $('#sidebar-cats');
    if (nav) {
      const items = [{ value: 'all', label: '全部笔记', count: allDocs.length }].concat(
        cats.map((c) => ({ value: c, label: c, count: counts.get(c) ?? 0 })),
      );
      nav.innerHTML = items
        .map((item) => {
          const icon =
            item.value === 'all'
              ? '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
              : '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/>';
          return (
            '<button class="sidebar-cat' +
            (current === item.value ? ' active' : '') +
            '" data-category="' +
            esc(item.value) +
            '" aria-pressed="' +
            (current === item.value ? 'true' : 'false') +
            '">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            icon +
            '</svg>' +
            '<span class="cat-name">' +
            esc(item.label) +
            '</span>' +
            '<span class="cat-count">' +
            item.count +
            '</span>' +
            '</button>'
          );
        })
        .join('');
    }
    if ($('#sidebar-conn')) {
      $('#sidebar-conn').textContent =
        state.connection === 'unconfigured' ? '未连接' : (state.baseUrl ?? '已连接');
    }
  }

  function openSidebar() {
    const layer = $('#sidebar-layer');
    if (!layer) return;
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
  }

  function closeSidebar() {
    const layer = $('#sidebar-layer');
    if (!layer) return;
    layer.classList.remove('open');
    layer.setAttribute('aria-hidden', 'true');
  }

  /** True when the left sidebar drawer is open (Android back handling). */
  function isSidebarOpen() {
    const layer = $('#sidebar-layer');
    return !!layer && layer.classList.contains('open');
  }

  /* ─── rendering: home ───────────────────────────────────── */
  /** 分类筛选条：全部 + 各顶层目录。搜索态隐藏（搜索是全局的）。 */
  function renderCategoryChips(state) {
    const categories = state.categories ?? [];
    const searching = (state.query ?? '').trim() !== '';
    const chipRow = $('#category-chips');
    if (!chipRow) return;
    if (searching || categories.length === 0) {
      chipRow.classList.add(HIDDEN);
      chipRow.innerHTML = '';
      return;
    }
    const current = state.category ?? 'all';
    const items = [{ value: 'all', label: '全部' }].concat(
      categories.map((c) => ({ value: c, label: c })),
    );
    chipRow.innerHTML = items
      .map(
        (item) =>
          '<button class="chip' +
          (current === item.value ? ' chip-on' : '') +
          '" data-category="' +
          esc(item.value) +
          '" aria-pressed="' +
          (current === item.value ? 'true' : 'false') +
          '">' +
          esc(item.label) +
          '</button>',
      )
      .join('');
    chipRow.classList.remove(HIDDEN);
  }

  function renderHome(state) {
    const query = (state.query ?? '').trim();
    const documents = state.documents ?? [];
    const noDocs = documents.length === 0;
    const searching = query !== '';

    if ($('#home-greeting')) {
      const g = todayGreeting();
      if (g) $('#home-greeting').textContent = g + ' · 离线可用';
    }

    // unconfigured/empty → setup prompt replaces the summary card
    const showPrompt = state.connection === 'unconfigured' && noDocs;
    toggleHidden($('#connect-prompt-wrap'), !showPrompt);
    toggleHidden($('#sync-card'), showPrompt);
    toggleHidden($('#auth-error-wrap'), state.connection !== 'auth-error');

    renderCategoryChips(state);
    // 「换一批」只在阅读态显示；搜索态结果按相关度排列，不随机。
    toggleHidden($('#btn-shuffle'), searching);

    if ($('#recent-count')) $('#recent-count').textContent = documents.length + ' 篇';

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
    const all = state.artifacts ?? [];
    // 只保留最新版本：按 mtime（ISO 8601，可字典序比较）取最新一个。
    // 旧版本仍可被服务端 manifest 列出（如历史日期命名），但这里不再展示。
    const list =
      all.length === 0
        ? []
        : [all.reduce((a, b) => (a.mtime >= b.mtime ? a : b))];
    toggleHidden($('#artifacts-section'), list.length === 0);
    if ($('#artifacts-count')) $('#artifacts-count').textContent = list.length + ' 个';
    if ($('#artifacts-list')) $('#artifacts-list').innerHTML = list.map(artifactRowHtml).join('');
    toggleHidden($('#artifacts-empty'), list.length !== 0);
  }

  /* ─── rendering: favorites ──────────────────────────────── */
  function renderFavs(state) {
    const favorites = state.favorites ?? [];
    // 收藏页不受首页分类筛选影响：基于全量文档。
    const allDocs = state.allDocuments ?? state.documents ?? [];
    const favDocs = allDocs.filter((d) => favorites.includes(d.id));
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
    // 统计基于全量文档，不受首页当前分类影响。
    const documents = state.allDocuments ?? state.documents ?? [];
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
      toggleHidden($('#detail-backlinks'), true);
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
    // 反向链接：引用当前笔记的其他笔记，点击可跳转（复用 data-open 委托）。
    const backlinks = detail.backlinks ?? [];
    const bl = $('#detail-backlinks');
    if (bl) {
      if (backlinks.length > 0) {
        bl.innerHTML =
          '<div class="section-head row-between" style="margin-bottom: 8px;">' +
          '<h2>反向链接</h2>' +
          '<span class="meta num">' +
          backlinks.length +
          ' 篇</span></div>' +
          '<div class="grouped">' +
          backlinks
            .map(
              (b) =>
                '<div class="list-row"><div class="body" data-open="' +
                esc(b.id) +
                '" role="button" tabindex="0" aria-label="打开笔记：' +
                esc(b.title) +
                '"><div class="title">' +
                esc(b.title) +
                '</div><div class="sub">引用了本篇笔记</div></div></div>',
            )
            .join('') +
          '</div>';
        bl.classList.remove(HIDDEN);
      } else {
        bl.classList.add(HIDDEN);
        bl.innerHTML = '';
      }
    }
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

  /* ─── rendering: assistant ──────────────────────────────── */
  function renderAssistant(state) {
    const messages = state.assistantMessages ?? [];
    const asking = !!state.assistantAsking;
    const list = $('#chat-list');
    const input = $('#chat-input');
    const sendBtn = $('#chat-send');
    const emptyWrap = $('#chat-empty-wrap');

    toggleHidden(emptyWrap, messages.length > 0 || asking);
    if (list) {
      const items = messages.map((m) => {
        if (m.role === 'user') {
          return '<div class="chat-msg user">' + esc(m.text) + '</div>';
        }
        return '<div class="chat-msg assistant detail-body">' + renderMarkdown(m.text ?? '') + '</div>';
      });
      if (asking) {
        items.push('<div class="chat-msg typing"><span class="t-dot"></span><span class="t-dot"></span><span class="t-dot"></span></div>');
      }
      list.innerHTML = items.join('');
      const scroll = $('#chat-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    }
    if (input) input.disabled = asking;
    if (sendBtn) sendBtn.disabled = asking;
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
    renderSidebar(state);
    renderAssistant(state);
    applyTab(state.tab ?? 'home');
  }

  /* ─── detail reading zoom: 双指缩放正文字号 ─────────────── */
  const READ_SCALE_KEY = 'ua-read-scale';
  const detailScroll = $('#detail-scroll');
  if (detailScroll) {
    let savedScale = 1;
    try {
      savedScale = clampReadScale(Number(viewport.localStorage?.getItem(READ_SCALE_KEY) ?? 1));
    } catch {
      savedScale = 1;
    }
    if (savedScale !== 1) detailScroll.style.setProperty('--read-scale', String(savedScale));

    let pinch = null;
    detailScroll.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          pinch = { startDist: touchDistance(e.touches), startScale: savedScale };
        }
      },
      { passive: true },
    );
    detailScroll.addEventListener(
      'touchmove',
      (e) => {
        if (pinch && e.touches.length === 2) {
          e.preventDefault();
          const ratio = touchDistance(e.touches) / (pinch.startDist || 1);
          savedScale = clampReadScale(pinch.startScale * ratio);
          detailScroll.style.setProperty('--read-scale', String(savedScale));
          try {
            viewport.localStorage.setItem(READ_SCALE_KEY, String(savedScale));
          } catch {
            // 缩放记忆是尽力而为。
          }
        }
      },
      { passive: false },
    );
    const endPinch = () => {
      pinch = null;
    };
    detailScroll.addEventListener('touchend', endPinch);
    detailScroll.addEventListener('touchcancel', endPinch);
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
  $('#btn-shuffle')?.addEventListener('click', () => wiring.onShuffle?.());

  /* ─── sidebar ───────────────────────────────────────────── */
  $('#btn-menu')?.addEventListener('click', openSidebar);
  $('#sidebar-scrim')?.addEventListener('click', closeSidebar);
  $('#sidebar-sync')?.addEventListener('click', () => {
    closeSidebar();
    wiring.onSync?.();
  });
  $('#sidebar-conn-open')?.addEventListener('click', () => {
    closeSidebar();
    openConnectionSheet();
    wiring.onConnectionChange?.({ action: 'open' });
  });

  /* ─── assistant chat ────────────────────────────────────── */
  function submitChat() {
    const input = $('#chat-input');
    if (!input || input.disabled) return;
    const question = input.value.trim();
    if (question === '') return;
    input.value = '';
    input.style.height = '';
    wiring.onSendQuestion?.(question);
  }
  $('#chat-send')?.addEventListener('click', submitChat);
  $('#chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitChat();
    }
  });
  $('#chat-input')?.addEventListener('input', (e) => {
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  });
  $('#btn-clear-chat')?.addEventListener('click', () => wiring.onClearChat?.());

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

  $('#conn-test')?.addEventListener('click', () => submitConnection('test'));
  $('#conn-save')?.addEventListener('click', () => submitConnection('save'));
  $('#conn-clear')?.addEventListener('click', () => wiring.onConnectionChange?.({ action: 'clear' }));
  $('#conn-base-url')?.addEventListener('input', () =>
    showConnectionErrors({ baseUrl: '', token: currentTokenError() }),
  );
  $('#conn-token')?.addEventListener('input', () =>
    showConnectionErrors({ baseUrl: currentBaseUrlError(), token: '', llmKey: currentLlmKeyError() }),
  );
  $('#conn-llm-key')?.addEventListener('input', () =>
    showConnectionErrors({ baseUrl: currentBaseUrlError(), token: currentTokenError(), llmKey: '' }),
  );

  function currentBaseUrlError() {
    const el = $('#conn-base-url-err');
    return el && !el.classList.contains(HIDDEN) ? el.textContent : '';
  }
  function currentTokenError() {
    const el = $('#conn-token-err');
    return el && !el.classList.contains(HIDDEN) ? el.textContent : '';
  }
  function currentLlmKeyError() {
    const el = $('#conn-llm-key-err');
    return el && !el.classList.contains(HIDDEN) ? el.textContent : '';
  }

  $('#detail-back')?.addEventListener('click', closeDetail);
  $('#detail-star')?.addEventListener('click', () => {
    if (currentDetailId) wiring.onToggleFavorite?.(currentDetailId);
  });
  $('#scrim')?.addEventListener('click', closeSheets);

  container.addEventListener('click', (e) => {
    const wikiLink = e.target.closest('[data-wiki-target]');
    if (wikiLink) {
      wiring.onOpenWikiLink?.(wikiLink.getAttribute('data-wiki-target'));
      return;
    }
    const category = e.target.closest('[data-category]');
    if (category) {
      closeSidebar();
      wiring.onSelectCategory?.(category.dataset.category);
      return;
    }
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
      if (isSidebarOpen()) closeSidebar();
      else if ($('#sheet-layer')?.classList.contains('open')) closeSheets();
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
    isSheetOpen,
    openSidebar,
    closeSidebar,
    isSidebarOpen,
    setConnectionBusy,
    setConnectionStatus,
    showConnectionErrors,
  };
}