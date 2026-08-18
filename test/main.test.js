import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { bootstrapApp } from '../src/main.js';
import { openKnowledgeDb, DB_NAME } from '../src/cache-db.js';
import { createConnectionStore, createWebAdapter } from '../src/connection-store.js';

/**
 * Bootstrap integration tests (jsdom + fake-indexeddb, no Capacitor).
 *
 * Regression: "点击同步没有反应" — runSync() used to return silently when
 * the API client/engine were not rebuilt (saved connection restore failed),
 * and bootstrapApp() would throw mid-startup when rebuildApi() rejected,
 * leaving the UI with a dead sync button. Also covers the request-timeout fix
 * (a hung download must not wedge sync forever).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', 'www', 'index.html'), 'utf8');

const VALID_BASE = 'https://kb-api.example.com';
const FAKE_TOKEN = 'uak_' + 'A'.repeat(43);

async function setupDom() {
  const dom = new JSDOM(HTML, {
    url: 'https://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  return dom;
}

let dom;
let db;
beforeEach(async () => {
  dom = await setupDom();
  // One shared in-memory database for the whole file; each test opens a new
  // connection. No deleteDatabase (avoids fake-indexeddb blocked races).
  db = await openKnowledgeDb();
});

afterEach(() => {
  dom?.window.close();
});

describe('bootstrapApp + runSync regression (sync button must never be dead)', () => {
  it('a saved connection that cannot be rebuilt falls back to unconfigured with a hint', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const brokenAdapter = {
      async get() {
        throw new Error('secure storage unavailable');
      },
      async set() {},
      async remove() {},
    };
    const brokenStore = createConnectionStore(brokenAdapter);

    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: brokenStore,
      dbImpl: db,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });

    // App must still be usable: connection prompt visible, not a dead button.
    expect(app.state.connection).toBe('unconfigured');
    const prompt = window.document.querySelector('#connect-prompt-wrap h3')?.textContent ?? '';
    expect(prompt).toContain('尚未连接知识库');
  });

  it('runSync with no engine shows a hint instead of failing silently', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);

    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });

    // No saved connection → engine/api are null; clicking sync must prompt.
    let toast = '';
    app.ui.toast = (m) => { toast = m; };
    await app.runSync();
    expect(toast).toContain('请先完成连接设置');
  });

  it('a hung download fails with NETWORK and sync surfaces the error (not stuck)', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });

    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      apiTimeoutMs: 30,
      // Manifest responds; document downloads hang → timeout must fire.
      fetchImpl: async (url) => {
        if (url.endsWith('/v1/manifest')) {
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              generatedAt: '2026-08-17T00:00:00Z',
              revision: 'a'.repeat(64),
              entries: [
                {
                  id: 'b'.repeat(43),
                  relativePath: 'wiki/a.md',
                  kind: 'document',
                  mime: 'text/markdown; charset=utf-8',
                  size: 4,
                  mtime: '2026-08-17T00:00:00Z',
                  sha256: 'c'.repeat(64),
                  title: 'A',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Promise(() => {}); // hang forever
      },
    });

    let toast = '';
    app.ui.toast = (m) => { toast = m; };
    await app.runSync();
    // Sync must finish (error path), not hang; UI surfaces 同步失败.
    expect(window.document.getElementById('sync-status-text').textContent).toContain('同步失败');
  });
});

describe('bootstrapApp — categories and shuffle', () => {
  it('classifies documents by top dir (wiki before outputs) and shuffles reading lists', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });

    // 种子缓存：manifest 故意让 outputs 先出现、wiki 后出现，验证分类排序不受影响。
    const bodies = ['R1 报告', 'R2 报告', 'A 笔记', 'B 笔记'];
    const paths = ['outputs/r1.md', 'outputs/r2.md', 'wiki/a.md', 'wiki/b.md'];
    const entries = paths.map((relativePath, i) => ({
      id: 'd' + String(i).padStart(42, '0'),
      relativePath,
      kind: 'document',
      mime: 'text/markdown; charset=utf-8',
      size: bodies[i].length,
      mtime: '2026-08-17T00:00:00Z',
      sha256: 'h' + String(i).padStart(63, '0'),
      title: relativePath.split('/')[1],
    }));
    const manifest = {
      schemaVersion: 1,
      generatedAt: '2026-08-17T00:00:00Z',
      revision: 'r' + 'f'.repeat(63),
      entries,
    };
    await db.commitRevision({
      revision: manifest.revision,
      manifest,
      contents: entries.map((e, i) => ({ sha256: e.sha256, text: bodies[i] })),
    });

    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      randomImpl: () => 0, // 确定性 Fisher–Yates 洗牌
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });

    // 分类：wiki 优先于 outputs，即使 manifest 顺序相反。
    expect(app.state.categories).toEqual(['wiki', 'outputs']);
    expect(app.state.allDocuments.map((d) => d.relativePath)).toEqual(paths);

    // 阅读列表（全部分类）：随机洗牌。
    // rng 恒 0 时：原序 [r1, r2, a, b] → [r2, a, b, r1]。
    expect(app.state.documents.map((d) => d.relativePath)).toEqual([
      'outputs/r2.md',
      'wiki/a.md',
      'wiki/b.md',
      'outputs/r1.md',
    ]);

    // 切到 wiki 分类：过滤后 [a, b] → 洗牌 [b, a]。
    container.querySelector('#category-chips [data-category="wiki"]').click();
    expect(app.state.category).toBe('wiki');
    expect(app.state.documents.map((d) => d.relativePath)).toEqual(['wiki/b.md', 'wiki/a.md']);

    // 换一批：重新洗牌当前分类（rng 恒 0 时顺序不变，但走了洗牌路径）。
    container.querySelector('#btn-shuffle').click();
    expect(app.state.documents.map((d) => d.relativePath)).toEqual(['wiki/b.md', 'wiki/a.md']);

    // 搜索：全局（跨分类）、不受随机影响；搜索态隐藏分类条与换一批按钮。
    const input = container.querySelector('#search-input');
    input.value = 'R1';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(app.state.query).toBe('R1');
    expect(app.state.documents.length).toBe(1);
    expect(app.state.documents.map((d) => d.relativePath)).toContain('outputs/r1.md');
    expect(container.querySelector('#category-chips').classList.contains('hidden')).toBe(true);
    expect(container.querySelector('#btn-shuffle').classList.contains('hidden')).toBe(true);
  });
});
