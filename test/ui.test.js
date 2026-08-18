import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { mountApp } from '../src/ui.js';
import { renderMarkdown } from '../src/markdown.js';

/**
 * UI wiring tests — the REAL shipped shell (www/index.html) is loaded into a
 * fresh jsdom window per test, then mountApp() binds and renders into it.
 * No Capacitor, no network, no storage beyond jsdom's own DOM.
 */

const INDEX_HTML = readFileSync(path.join(process.cwd(), 'www', 'index.html'), 'utf8');

/** Test-only fake device token (valid shape, but built at runtime). */
function fakeToken() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let body = '';
  for (let i = 0; i < 43; i += 1) body += alphabet[i % alphabet.length];
  return 'uak_' + body;
}

const FAKE_TOKEN = fakeToken();
const REV = 'a'.repeat(64);

function docFixture(id, overrides = {}) {
  return {
    id,
    title: '标题 ' + id,
    excerpt: '摘要 ' + id,
    label: 'wiki',
    updated: '2026-01-01',
    relativePath: 'wiki/' + id + '.md',
    sha256: 'b'.repeat(64),
    mtime: '2026-01-01T00:00:00Z',
    size: 120,
    ...overrides,
  };
}

function artifactFixture(id, overrides = {}) {
  return {
    id,
    title: '发布包 ' + id,
    relativePath: 'outputs/' + id + '.apk',
    sha256: 'c'.repeat(64),
    size: 4096,
    mtime: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return {
    connection: 'connected',
    baseUrl: 'https://kb.example.com',
    tokenPresent: true,
    storageWarning: null,
    syncing: false,
    syncPhase: null,
    syncCounts: null,
    lastSyncAt: null,
    activeRevision: REV,
    syncError: null,
    query: '',
    documents: [],
    artifacts: [],
    favorites: [],
    detail: null,
    tab: 'home',
    ...overrides,
  };
}

function mountDOM(wiringOverrides = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'https://local.test/' });
  const container = dom.window.document.querySelector('#screen');
  const calls = { sync: 0, open: [], fav: [], conn: [], query: [], dl: [], close: [], tab: [], cat: [], shuffle: 0 };
  const wiring = {
    onSync: () => {
      calls.sync += 1;
    },
    onOpenDocument: (id) => {
      calls.open.push(id);
    },
    onToggleFavorite: (id) => {
      calls.fav.push(id);
    },
    onConnectionChange: (payload) => {
      calls.conn.push(payload);
    },
    onQueryChange: (q) => {
      calls.query.push(q);
    },
    onDownloadArtifact: (id) => {
      calls.dl.push(id);
    },
    onCloseDetail: (id) => {
      calls.close.push(id);
    },
    onSelectTab: (t) => {
      calls.tab.push(t);
    },
    onSelectCategory: (c) => {
      calls.cat.push(c);
    },
    onShuffle: () => {
      calls.shuffle += 1;
    },
    ...wiringOverrides,
  };
  const ui = mountApp(container, wiring);
  return { dom, container, ui, calls, window: dom.window };
}

const $id = (container, id) => container.querySelector('#' + id);
const isHidden = (el) => !el || el.classList.contains('hidden');

describe('mountApp — reads the shipped shell, no write affordances', () => {
  it('renders cached documents into the recent list', () => {
    const { container, ui } = mountDOM();
    ui.update(
      baseState({
        documents: [docFixture('d1'), docFixture('d2')],
      }),
    );
    expect($id(container, 'recent-list').children.length).toBe(2);
    expect($id(container, 'recent-list').textContent).toContain('标题 d1');
  });

  it('removes the 新建笔记 / AI 问答 / 分享 mock flows from the shipped shell', () => {
    expect(INDEX_HTML).not.toContain('btn-new-note');
    expect(INDEX_HTML).not.toContain('btn-ai');
    expect(INDEX_HTML).not.toContain('sheet-note');
    expect(INDEX_HTML).not.toContain('sheet-ai');
    expect(INDEX_HTML).not.toContain('sheet-share');
    expect(INDEX_HTML).not.toContain('detail-share');
    expect(INDEX_HTML).not.toContain("id='sheet-share'");
    // The mock NOTES data flows and their handlers are gone with the IIFE.
    expect(INDEX_HTML).not.toMatch(/var\s+NOTES\s*=/);
    expect(INDEX_HTML).not.toContain('AI_ANSWER');
    expect(INDEX_HTML).not.toContain('saveNote');
    expect(INDEX_HTML).toContain('type="module"');
    expect(INDEX_HTML).toContain('./assets/app.js');
  });

  it('renders no write affordance anywhere in the mounted view', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')] }));
    expect(container.querySelector('#btn-new-note')).toBeNull();
    expect(container.querySelector('#btn-ai')).toBeNull();
    expect(container.textContent).not.toContain('新建笔记');
  });
});

describe('mountApp — connection states', () => {
  it('unconfigured shows the connection setup prompt and hides the list', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ connection: 'unconfigured', documents: [] }));
    expect(isHidden($id(container, 'connect-prompt-wrap'))).toBe(false);
    expect(isHidden($id(container, 'recent-empty'))).toBe(true);
    expect(isHidden($id(container, 'sync-card'))).toBe(true);

    $id(container, 'btn-open-connection').click();
    expect($id(container, 'sheet-connection').classList.contains('open')).toBe(true);
    expect(calls.conn.at(-1)).toEqual({ action: 'open' });
  });

  it('configured with an empty cache shows the 空态 and a working sync CTA', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [] }));
    expect(isHidden($id(container, 'recent-empty'))).toBe(false);
    expect($id(container, 'recent-empty').textContent).toContain('还没有内容');
    expect(isHidden($id(container, 'connect-prompt-wrap'))).toBe(true);

    $id(container, 'btn-recent-sync').click();
    expect(calls.sync).toBe(1);
  });

  it('auth failure shows the retry card while keeping cached notes browsable', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(
      baseState({ connection: 'auth-error', documents: [docFixture('d1')] }),
    );
    expect(isHidden($id(container, 'auth-error-wrap'))).toBe(false);
    expect($id(container, 'recent-list').children.length).toBe(1);

    $id(container, 'btn-auth-retry').click();
    expect(calls.sync).toBe(1);
    $id(container, 'btn-conn-settings').click();
    expect($id(container, 'sheet-connection').classList.contains('open')).toBe(true);
  });
});

describe('mountApp — sync phases and results', () => {
  it('shows phase text and disables the sync button while syncing', () => {
    const { container, ui } = mountDOM();
    const phases = [
      ['manifest', '获取目录'],
      ['download', '下载文档'],
      ['verify', '校验内容'],
      ['commit', '写入本地'],
    ];
    for (const [phase, hint] of phases) {
      ui.update(baseState({ syncing: true, syncPhase: phase, syncCounts: { total: 5, downloaded: 2, verified: 3 } }));
      expect($id(container, 'sync-status-text').textContent).toContain('正在同步');
      expect($id(container, 'sync-status-text').textContent).toContain(hint);
      expect($id(container, 'btn-sync').disabled).toBe(true);
      if (phase === 'download') {
        expect($id(container, 'sync-count-text').textContent).toContain('2 篇');
      }
    }
  });

  it('shows the added/updated/removed/unchanged result counts on success', () => {
    const { container, ui } = mountDOM();
    ui.update(
      baseState({
        syncing: false,
        syncPhase: 'complete',
        syncCounts: { added: 2, updated: 1, removed: 1, unchanged: 10 },
        lastSyncAt: '2026-03-24T08:00:00Z',
      }),
    );
    const text = $id(container, 'sync-status-text').textContent;
    expect(text).toContain('同步完成');
    expect($id(container, 'sync-count-text').textContent).toContain('新增 2');
    expect($id(container, 'sync-count-text').textContent).toContain('更新 1');
    expect($id(container, 'sync-count-text').textContent).toContain('移除 1');
    expect($id(container, 'btn-sync').disabled).toBe(false);
  });

  it('reports 已是最新 when a sync changes nothing', () => {
    const { container, ui } = mountDOM();
    ui.update(
      baseState({ syncing: false, syncPhase: 'complete', syncCounts: { added: 0, updated: 0, removed: 0, unchanged: 12 } }),
    );
    expect($id(container, 'sync-status-text').textContent).toBe('已是最新');
  });

  it('offline cached view: a failed sync keeps the cached list visible', () => {
    const { container, ui } = mountDOM();
    ui.update(
      baseState({
        documents: [docFixture('d1')],
        syncError: '网络请求失败',
        syncCounts: null,
      }),
    );
    expect($id(container, 'sync-status-text').textContent).toContain('同步失败');
    expect($id(container, 'recent-list').children.length).toBe(1);
  });

  it('manual sync button fires onSync when not already syncing', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')] }));
    $id(container, 'btn-sync').click();
    expect(calls.sync).toBe(1);
    ui.update(baseState({ syncing: true, syncPhase: 'download', syncCounts: { downloaded: 1 } }));
    $id(container, 'btn-sync').click();
    expect(calls.sync).toBe(1);
  });
});

describe('mountApp — search', () => {
  it('typing in the search box drives onQueryChange and search results render', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1'), docFixture('d2')] }));

    const input = $id(container, 'search-input');
    input.value = '知识';
    input.dispatchEvent(new container.ownerDocument.defaultView.Event('input', { bubbles: true }));
    expect(calls.query).toEqual(['知识']);
    expect(isHidden($id(container, 'search-clear'))).toBe(false);

    ui.update(
      baseState({
        query: '知识',
        documents: [docFixture('d1')],
      }),
    );
    expect(isHidden($id(container, 'search-head'))).toBe(false);
    expect($id(container, 'sh-count').textContent).toContain('1 篇');
    expect($id(container, 'recent-list').children.length).toBe(1);
  });

  it('empty search results show the empty state with the query echoed', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ query: '不存在词', documents: [] }));
    expect(isHidden($id(container, 'search-empty'))).toBe(false);
    expect($id(container, 'search-empty-q').textContent).toBe('不存在词');
    expect($id(container, 'search-head').textContent).toContain('0 篇');
  });

  it('clearing the search restores the full list', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ query: 'x', documents: [] }));
    $id(container, 'search-clear2').click();
    expect(calls.query).toEqual(['']);
  });
});

describe('mountApp — categories and shuffle', () => {
  it('renders category chips (全部 + dirs) and highlights the active one', () => {
    const { container, ui } = mountDOM();
    ui.update(
      baseState({
        documents: [
          docFixture('d1'),
          docFixture('d2', { label: 'outputs', relativePath: 'outputs/x.md' }),
        ],
        categories: ['wiki', 'outputs'],
        category: 'wiki',
      }),
    );
    expect(isHidden($id(container, 'category-chips'))).toBe(false);
    const chips = Array.from(container.querySelectorAll('#category-chips [data-category]'));
    expect(chips.map((c) => c.dataset.category)).toEqual(['all', 'wiki', 'outputs']);
    expect(container.querySelector('#category-chips [data-category="wiki"]').classList.contains('chip-on')).toBe(true);
    expect(container.querySelector('#category-chips [data-category="all"]').getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('#category-chips [data-category="wiki"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking a category chip fires onSelectCategory', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')], categories: ['wiki'], category: 'all' }));
    container.querySelector('#category-chips [data-category="wiki"]').click();
    expect(calls.cat).toEqual(['wiki']);
  });

  it('hides category chips while searching (search is global)', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ query: '知识', documents: [docFixture('d1')], categories: ['wiki'] }));
    expect(isHidden($id(container, 'category-chips'))).toBe(true);
  });

  it('shuffle button fires onShuffle in reading mode and is hidden while searching', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')], categories: ['wiki'] }));
    expect(isHidden($id(container, 'btn-shuffle'))).toBe(false);
    $id(container, 'btn-shuffle').click();
    expect(calls.shuffle).toBe(1);
    ui.update(baseState({ query: '知识', documents: [], categories: ['wiki'] }));
    expect(isHidden($id(container, 'btn-shuffle'))).toBe(true);
  });

  it('hides the category row entirely when there is only one category', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')], categories: ['wiki'], category: 'wiki' }));
    expect(isHidden($id(container, 'category-chips'))).toBe(false);
    ui.update(baseState({ documents: [docFixture('d1')], categories: [], category: 'all' }));
    expect(isHidden($id(container, 'category-chips'))).toBe(true);
  });
});

describe('mountApp — Obsidian sidebar', () => {
  it('the hamburger button opens the left sidebar and the scrim closes it', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')] }));
    expect(ui.isSidebarOpen()).toBe(false);
    $id(container, 'btn-menu').click();
    expect(ui.isSidebarOpen()).toBe(true);
    expect($id(container, 'sidebar-layer').getAttribute('aria-hidden')).toBe('false');
    $id(container, 'sidebar-scrim').click();
    expect(ui.isSidebarOpen()).toBe(false);
  });

  it('renders the category tree with counts and highlights the active one', () => {
    const { container, ui } = mountDOM();
    ui.update(
      baseState({
        documents: [docFixture('d1')],
        allDocuments: [docFixture('d1'), docFixture('d2', { label: 'outputs', relativePath: 'outputs/x.md' })],
        categories: ['wiki', 'outputs'],
        category: 'wiki',
      }),
    );
    $id(container, 'btn-menu').click();
    const rows = Array.from(container.querySelectorAll('#sidebar-cats [data-category]'));
    expect(rows.map((r) => r.dataset.category)).toEqual(['all', 'wiki', 'outputs']);
    expect(container.querySelector('#sidebar-cats [data-category="all"] .cat-count').textContent).toBe('2');
    expect(container.querySelector('#sidebar-cats [data-category="wiki"] .cat-count').textContent).toBe('1');
    expect(container.querySelector('#sidebar-cats [data-category="wiki"]').classList.contains('active')).toBe(true);
  });

  it('picking a category from the sidebar fires onSelectCategory and closes the drawer', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')], categories: ['wiki'], category: 'all' }));
    $id(container, 'btn-menu').click();
    container.querySelector('#sidebar-cats [data-category="wiki"]').click();
    expect(calls.cat).toEqual(['wiki']);
    expect(ui.isSidebarOpen()).toBe(false);
  });

  it('sidebar sync action fires onSync; connection action opens the sheet', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')] }));
    $id(container, 'btn-menu').click();
    $id(container, 'sidebar-sync').click();
    expect(calls.sync).toBe(1);
    expect(ui.isSidebarOpen()).toBe(false);

    $id(container, 'btn-menu').click();
    $id(container, 'sidebar-conn-open').click();
    expect($id(container, 'sheet-connection').classList.contains('open')).toBe(true);
    expect(ui.isSidebarOpen()).toBe(false);
  });

  it('Escape closes the sidebar before sheets', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState());
    $id(container, 'btn-menu').click();
    const esc = new container.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    container.dispatchEvent(esc);
    expect(ui.isSidebarOpen()).toBe(false);
  });
});

describe('mountApp — documents and favorites', () => {
  it('opening a note card invokes onOpenDocument', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1', { title: '第一篇' })] }));
    container.querySelector('[data-open="d1"]').click();
    expect(calls.open).toEqual(['d1']);
  });

  it('detail renders the sanitized markdown body, title and chips', () => {
    const { container, ui } = mountDOM();
    const html = renderMarkdown('# 大标题\n\n正文 **加粗** 内容。');
    ui.update(
      baseState({
        detail: { id: 'd1', title: '第一篇', chips: ['wiki', '2026-01-01'], html },
        documents: [docFixture('d1')],
      }),
    );
    expect(container.classList.contains('detail-open')).toBe(true);
    expect($id(container, 'detail-title').textContent).toBe('第一篇');
    expect($id(container, 'detail-body').innerHTML).toContain('<h1>大标题</h1>');
    expect($id(container, 'detail-body').querySelector('strong').textContent).toBe('加粗');
    expect($id(container, 'detail-chips').textContent).toContain('wiki');
  });

  it('back closes the detail and fires onCloseDetail', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ detail: { id: 'd1', title: 't', chips: [], html: '<p>x</p>' } }));
    $id(container, 'detail-back').click();
    expect(container.classList.contains('detail-open')).toBe(false);
    expect(calls.close).toEqual(['d1']);
  });

  it('favorites tab lists starred documents and toggling a star fires onToggleFavorite', () => {
    const { container, ui, calls, window } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1'), docFixture('d2')], favorites: ['d1'] }));

    container.querySelector('[data-tab="favs"]').click();
    expect(calls.tab).toEqual(['favs']);
    expect($id(container, 'view-favs').classList.contains('active')).toBe(true);
    expect($id(container, 'fav-count').textContent).toContain('1 篇');
    expect(container.querySelector('[data-toggle-fav="d1"]').classList.contains('on')).toBe(true);

    container.querySelector('[data-toggle-fav="d1"]').click();
    expect(calls.fav).toEqual(['d1']);
  });

  it('favorites come from the full document set, not the home category filter', () => {
    const { container, ui } = mountDOM();
    ui.update(
      baseState({
        // 首页当前只看 wiki（d1）；收藏的是 outputs 里的 d2
        documents: [docFixture('d1')],
        allDocuments: [
          docFixture('d1'),
          docFixture('d2', { label: 'outputs', relativePath: 'outputs/y.md' }),
        ],
        categories: ['wiki', 'outputs'],
        category: 'wiki',
        favorites: ['d2'],
      }),
    );
    container.querySelector('[data-tab="favs"]').click();
    expect($id(container, 'fav-count').textContent).toContain('1 篇');
    expect(container.querySelector('[data-toggle-fav="d2"]')).toBeTruthy();
  });

  it('empty favorites show the empty card', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')], favorites: [] }));
    container.querySelector('[data-tab="favs"]').click();
    expect(isHidden($id(container, 'fav-empty'))).toBe(false);
  });

  it('detail star reflects favorite state and toggles through the wiring', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(
      baseState({
        documents: [docFixture('d1')],
        favorites: ['d1'],
        detail: { id: 'd1', title: 't', chips: [], html: '<p>x</p>' },
      }),
    );
    const star = $id(container, 'detail-star');
    expect(star.classList.contains('on')).toBe(true);
    expect(star.getAttribute('aria-pressed')).toBe('true');
    star.click();
    expect(calls.fav).toEqual(['d1']);
  });
});

describe('mountApp — artifacts', () => {
  it('shows only the newest artifact and wires its download to the hook', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(
      baseState({
        artifacts: [
          artifactFixture('a1', { mtime: '2026-01-01T00:00:00Z' }),
          artifactFixture('a2', { mtime: '2026-02-01T00:00:00Z' }),
        ],
      }),
    );
    expect(isHidden($id(container, 'artifacts-section'))).toBe(false);
    expect($id(container, 'artifacts-count').textContent).toContain('1');
    expect($id(container, 'artifacts-list').textContent).toContain('发布包 a2');
    expect($id(container, 'artifacts-list').textContent).not.toContain('发布包 a1');

    container.querySelector('[data-download-id="a2"]').click();
    expect(calls.dl).toEqual(['a2']);
  });

  it('the artifacts section lives on the me page, not the home page', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ artifacts: [artifactFixture('a1')] }));
    expect($id(container, 'view-me').querySelector('#artifacts-section')).toBeTruthy();
    expect($id(container, 'view-home').querySelector('#artifacts-section')).toBeNull();
  });

  it('hides the artifacts section when there are none', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ artifacts: [] }));
    expect(isHidden($id(container, 'artifacts-section'))).toBe(true);
    expect(isHidden($id(container, 'artifacts-empty'))).toBe(false);
  });
});

describe('mountApp — connection sheet', () => {
  it('prefills the base URL but never the secret token', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ baseUrl: 'https://kb.example.com', tokenPresent: true }));
    $id(container, 'setting-connection').click();
    expect($id(container, 'sheet-connection').classList.contains('open')).toBe(true);
    expect($id(container, 'conn-base-url').value).toBe('https://kb.example.com');
    expect($id(container, 'conn-token').value).toBe('');
    expect($id(container, 'conn-token').type).toBe('password');
  });

  it('validates the form before calling onConnectionChange for save', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState());
    $id(container, 'setting-connection').click();
    $id(container, 'conn-base-url').value = 'not a url';
    $id(container, 'conn-token').value = '';
    $id(container, 'conn-save').click();
    expect(calls.conn.filter((c) => c.action !== 'open')).toEqual([]);
    expect(isHidden($id(container, 'conn-base-url-err'))).toBe(false);
    expect($id(container, 'conn-base-url-err').textContent.length).toBeGreaterThan(0);
  });

  it('requires a token when none is configured yet', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ connection: 'unconfigured', tokenPresent: false, baseUrl: null }));
    $id(container, 'setting-connection').click();
    $id(container, 'conn-base-url').value = 'https://kb.example.com';
    $id(container, 'conn-token').value = '';
    $id(container, 'conn-save').click();
    expect(calls.conn.filter((c) => c.action !== 'open')).toEqual([]);
    expect(isHidden($id(container, 'conn-token-err'))).toBe(false);
    expect($id(container, 'conn-token-err').textContent.length).toBeGreaterThan(0);
  });

  it('save/test/clear carry the expected payloads; empty token means keep existing', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ baseUrl: 'https://kb.example.com', tokenPresent: true }));
    $id(container, 'setting-connection').click();

    $id(container, 'conn-base-url').value = 'https://kb.example.com/';
    $id(container, 'conn-token').value = '';
    $id(container, 'conn-save').click();
    expect(calls.conn.at(-1)).toEqual({ action: 'save', baseUrl: 'https://kb.example.com/', token: '' });

    $id(container, 'conn-token').value = FAKE_TOKEN;
    $id(container, 'conn-test').click();
    expect(calls.conn.at(-1)).toEqual({ action: 'test', baseUrl: 'https://kb.example.com/', token: FAKE_TOKEN });

    $id(container, 'conn-clear').click();
    expect(calls.conn.at(-1)).toEqual({ action: 'clear' });
  });

  it('keeps the token out of the rendered DOM even while it is typed into the masked field', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState());
    $id(container, 'setting-connection').click();
    $id(container, 'conn-token').value = FAKE_TOKEN;
    expect(container.textContent).not.toContain(FAKE_TOKEN);
    $id(container, 'conn-test').click();
    expect(calls.conn.at(-1).token).toBe(FAKE_TOKEN);
    expect(container.textContent).not.toContain(FAKE_TOKEN);
  });

  it('busy state disables the action buttons and status text is rendered', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState());
    $id(container, 'setting-connection').click();
    ui.setConnectionBusy(true);
    expect($id(container, 'conn-test').disabled).toBe(true);
    expect($id(container, 'conn-save').disabled).toBe(true);
    ui.setConnectionStatus('连接成功', 'success');
    expect($id(container, 'conn-status').textContent).toBe('连接成功');
    ui.setConnectionBusy(false);
    expect($id(container, 'conn-save').disabled).toBe(false);
  });

  it('clearing the token error when the user starts typing again', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState({ connection: 'unconfigured', tokenPresent: false, baseUrl: null }));
    $id(container, 'setting-connection').click();
    $id(container, 'conn-base-url').value = 'https://kb.example.com';
    $id(container, 'conn-save').click();
    expect(isHidden($id(container, 'conn-token-err'))).toBe(false);
    $id(container, 'conn-token').value = '@@@';
    $id(container, 'conn-token').dispatchEvent(
      new container.ownerDocument.defaultView.Event('input', { bubbles: true }),
    );
    expect(isHidden($id(container, 'conn-token-err'))).toBe(true);
  });
});

describe('mountApp — tabs, theme, sheets and toast', () => {
  it('switchTab moves the active view and fires onSelectTab', () => {
    const { container, ui, calls } = mountDOM();
    ui.update(baseState({ documents: [docFixture('d1')] }));
    container.querySelector('[data-tab="me"]').click();
    expect(calls.tab).toEqual(['me']);
    expect($id(container, 'view-me').classList.contains('active')).toBe(true);
    expect($id(container, 'view-home').classList.contains('active')).toBe(false);
  });

  it('appearance option updates the theme and the summary label', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState());
    $id(container, 'setting-appearance').click();
    container.querySelector('#sheet-appearance .option-row[data-value="dark"]').click();
    expect(container.dataset.theme).toBe('dark');
    expect($id(container, 'set-appearance-sub').textContent).toBe('深色');
  });

  it('opens and closes the about sheet', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState());
    $id(container, 'setting-about').click();
    expect($id(container, 'sheet-about').classList.contains('open')).toBe(true);
    $id(container, 'about-done').click();
    expect($id(container, 'sheet-layer').classList.contains('open')).toBe(false);
  });

  it('scrim click closes any open sheet', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState());
    $id(container, 'setting-about').click();
    $id(container, 'scrim').click();
    expect($id(container, 'sheet-layer').classList.contains('open')).toBe(false);
  });

  it('toast renders the message', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState());
    ui.toast('已收藏');
    expect($id(container, 'toast').classList.contains('show')).toBe(true);
    expect($id(container, 'toast').textContent).toContain('已收藏');
  });

  it('a complete render carries no credential-shaped text anywhere in the DOM', () => {
    const { container, ui } = mountDOM();
    ui.update(
      baseState({
        documents: [docFixture('d1')],
        artifacts: [artifactFixture('a1')],
        favorites: ['d1'],
        syncCounts: { added: 1, updated: 0, removed: 0, unchanged: 0 },
      }),
    );
    expect(container.textContent).not.toMatch(/uak_[A-Za-z0-9_-]{43}/);
    expect(container.innerHTML).not.toMatch(/uak_[A-Za-z0-9_-]{43}/);
  });

  it('home greeting is filled by the renderer', () => {
    const { container, ui } = mountDOM();
    ui.update(baseState());
    expect($id(container, 'home-greeting').textContent.trim().length).toBeGreaterThan(0);
  });
});