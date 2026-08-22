import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('bootstrapApp — assistant ask flow', () => {
  const SYNC_BODY = '同步协议\n\nmanifest 指纹缓存 TTL 5 秒，任何增删改都会失效重建。';

  async function seedCache() {
    // 共享内存数据库：先清掉上个用例残留的对话历史，保证断言独立。
    await db.clearAssistantMessages();
    const entry = {
      id: 'd' + '0'.repeat(42),
      relativePath: 'wiki/同步协议.md',
      kind: 'document',
      mime: 'text/markdown; charset=utf-8',
      size: SYNC_BODY.length,
      mtime: '2026-08-18T00:00:00Z',
      sha256: 'h' + '0'.repeat(63),
      title: '同步协议',
    };
    const agentsText = '# AGENTS\n先阅读工作区规则，再执行用户请求。';
    const agentsEntry = {
      id: 'a'.repeat(43),
      relativePath: 'AGENTS.md',
      kind: 'document',
      mime: 'text/markdown; charset=utf-8',
      size: agentsText.length,
      mtime: '2026-08-18T00:00:00Z',
      sha256: 'a'.repeat(64),
      title: 'AGENTS',
    };
    const manifest = {
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00Z',
      revision: 'r' + 'f'.repeat(63),
      entries: [agentsEntry, entry],
    };
    await db.commitRevision({
      revision: manifest.revision,
      manifest,
      contents: [
        { sha256: agentsEntry.sha256, text: agentsText },
        { sha256: entry.sha256, text: SYNC_BODY },
      ],
    });
  }

  it('retrieves local knowledge, asks the server and persists the reply', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });
    await seedCache();

    let askBody = null;
    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      randomImpl: () => 0,
      fetchImpl: async (url, opts) => {
        if (String(url).endsWith('/v1/ask')) {
          askBody = JSON.parse(opts.body);
          return new Response(JSON.stringify({ answer: '是的，指纹缓存 TTL 5 秒。' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error('unexpected fetch: ' + String(url));
      },
    });

    const input = container.querySelector('#chat-input');
    input.value = '同步的缓存多久失效？';
    container.querySelector('#chat-send').click();

    await vi.waitFor(() => {
      expect(app.state.assistantMessages.length).toBe(2);
    });

    expect(app.state.assistantMessages[0]).toMatchObject({
      role: 'user',
      text: '同步的缓存多久失效？',
    });
    expect(app.state.assistantMessages[1]).toMatchObject({
      role: 'assistant',
      text: '是的，指纹缓存 TTL 5 秒。',
    });
    expect(app.state.assistantAsking).toBe(false);

    // 本地检索出知识上下文并随请求发送
    expect(askBody).not.toBeNull();
    expect(askBody.question).toBe('同步的缓存多久失效？');
    expect(askBody.knowledge.length).toBeGreaterThan(0);
    expect(askBody.knowledge[0].relativePath).toBe('wiki/同步协议.md');
    expect(askBody.agentInstructions).toContain('先阅读工作区规则');

    // 对话历史已持久化到 IndexedDB
    const persisted = await db.listAssistantMessages();
    expect(persisted.length).toBe(2);
  });

  it('sends prior conversation turns as history so follow-ups keep context', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });
    await seedCache();

    const askBodies = [];
    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      randomImpl: () => 0,
      fetchImpl: async (url, opts) => {
        if (String(url).endsWith('/v1/ask')) {
          askBodies.push(JSON.parse(opts.body));
          return new Response(JSON.stringify({ answer: '来自助手第 ' + askBodies.length + ' 轮回答' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error('unexpected fetch: ' + String(url));
      },
    });

    const input = container.querySelector('#chat-input');
    // 第一轮：无历史
    input.value = '第一个问题';
    container.querySelector('#chat-send').click();
    await vi.waitFor(() => {
      expect(app.state.assistantMessages.length).toBe(2);
    });
    expect(askBodies[0].history).toEqual([]);

    // 第二轮：应带上第一轮的两条消息（user + assistant），且不含本次问题
    input.value = '第二个问题';
    container.querySelector('#chat-send').click();
    await vi.waitFor(() => {
      expect(app.state.assistantMessages.length).toBe(4);
    });
    expect(askBodies[1].history).toEqual([
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '来自助手第 1 轮回答' },
    ]);
    expect(askBodies[1].question).toBe('第二个问题');

    // 新建对话后：历史清空，下一轮不再携带旧对话
    container.querySelector('#btn-clear-chat').click();
    await vi.waitFor(() => {
      expect(app.state.assistantMessages.length).toBe(0);
    });
    input.value = '新对话第一个问题';
    container.querySelector('#chat-send').click();
    await vi.waitFor(() => {
      expect(app.state.assistantMessages.length).toBe(2);
    });
    expect(askBodies[2].history).toEqual([]);
  });

  it('surfaces assistant_unavailable (503) as a toast without wedging the app', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });
    await seedCache();

    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/v1/ask')) {
          return new Response(JSON.stringify({ error: 'assistant_not_configured' }), { status: 503 });
        }
        throw new Error('unexpected fetch: ' + String(url));
      },
    });

    let toast = '';
    app.ui.toast = (m) => {
      toast = m;
    };
    const input = container.querySelector('#chat-input');
    input.value = '你好';
    container.querySelector('#chat-send').click();

    await vi.waitFor(() => {
      expect(app.state.assistantAsking).toBe(false);
    });
    expect(toast).toContain('助手未配置');
    // 只保留用户消息，助手未作答
    expect(app.state.assistantMessages.length).toBe(1);
    expect(app.state.assistantMessages[0].role).toBe('user');
  });

  it('uses the on-device LLM when an API key is configured (no sync server involved)', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN, llmApiKey: 'sk-phone-key-12345' });
    await seedCache();

    let transportCall = null;
    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      randomImpl: () => 0,
      llmTransport: async (req) => {
        transportCall = req;
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ choices: [{ message: { content: '内置回答：指纹缓存 TTL 5 秒。' } }] }),
        };
      },
      fetchImpl: async () => {
        throw new Error('server must not be called for the on-device assistant');
      },
    });

    expect(app.state.llmApiKey).toBe('sk-phone-key-12345');

    const input = container.querySelector('#chat-input');
    input.value = '缓存多久失效？';
    container.querySelector('#chat-send').click();

    await vi.waitFor(() => {
      expect(app.state.assistantMessages.length).toBe(2);
    });
    expect(app.state.assistantMessages[1].text).toContain('内置回答');
    // 直连 LLM：transport 收到 key、问题与本地检索出的知识片段。
    expect(transportCall).not.toBeNull();
    expect(transportCall.apiKey).toBe('sk-phone-key-12345');
    expect(transportCall.messages[1].content).toContain('缓存多久失效？');
    expect(transportCall.messages[1].content).toContain('wiki/同步协议.md');
    expect(transportCall.messages[0].content).toContain('先阅读工作区规则');
  });

  it('stops a pending answer and ignores any late model result', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN, llmApiKey: 'sk-phone-key-12345' });
    await seedCache();

    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      llmTransport: async () => new Promise(() => {}),
      fetchImpl: async () => { throw new Error('server must not be called'); },
    });
    let toast = '';
    app.ui.toast = (message) => { toast = message; };
    const input = container.querySelector('#chat-input');
    input.value = '请长篇回答';
    container.querySelector('#chat-send').click();
    await vi.waitFor(() => expect(app.state.assistantAsking).toBe(true));
    expect(app.state.assistantTrace.map((step) => step.label)).toContain('已完整读取 AGENTS.md');

    container.querySelector('#chat-send').click();
    await vi.waitFor(() => expect(app.state.assistantAsking).toBe(false));
    expect(app.state.assistantMessages.map((m) => m.role)).toEqual(['user']);
    expect(toast).toContain('已停止回答');
  });
});

describe('bootstrapApp — Obsidian wiki links', () => {
  it('navigates between notes by clicking a [[双链]]', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });

    const bodies = ['# 协议\n\n见 [[运行指南]] 的说明。', '# 运行指南\n\n这里是操作步骤。'];
    const paths = ['wiki/协议.md', 'wiki/运行指南.md'];
    const entries = paths.map((relativePath, i) => ({
      id: 'd' + String(i).padStart(42, '0'),
      relativePath,
      kind: 'document',
      mime: 'text/markdown; charset=utf-8',
      size: bodies[i].length,
      mtime: '2026-08-18T00:00:00Z',
      sha256: 'h' + String(i).padStart(63, '0'),
      title: relativePath.split('/')[1].replace('.md', ''),
    }));
    const manifest = {
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00Z',
      revision: 'r' + 'e'.repeat(63),
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
      randomImpl: () => 0,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });

    // 打开「协议」笔记（列表随机排序，用 data-open 精确定位）。
    const id0 = 'd' + '0'.repeat(42);
    const id1 = 'd' + '1'.padStart(42, '0');
    container.querySelector('[data-open="' + id0 + '"]').click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(id0));

    // 点正文里的双链 → 跳到「运行指南」。
    const link = container.querySelector('.wiki-link');
    expect(link).toBeTruthy();
    expect(link.getAttribute('data-wiki-target')).toBe('运行指南');
    link.click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(id1));
    expect(container.querySelector('#detail-title').textContent).toContain('运行指南');
  });

  it('shows a toast when a wiki link target does not exist', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });

    const body = '# 协议\n\n见 [[不存在的页面]]。';
    const entry = {
      id: 'd' + '0'.repeat(42),
      relativePath: 'wiki/协议.md',
      kind: 'document',
      mime: 'text/markdown; charset=utf-8',
      size: body.length,
      mtime: '2026-08-18T00:00:00Z',
      sha256: 'h' + '0'.repeat(63),
      title: '协议',
    };
    const manifest = {
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00Z',
      revision: 'r' + 'd'.repeat(63),
      entries: [entry],
    };
    await db.commitRevision({
      revision: manifest.revision,
      manifest,
      contents: [{ sha256: entry.sha256, text: body }],
    });

    const app = await bootstrapApp({
      container,
      isNative: false,
      connectionStoreImpl: store,
      dbImpl: db,
      randomImpl: () => 0,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    let toast = '';
    app.ui.toast = (m) => {
      toast = m;
    };

    container.querySelector('[data-open="d' + '0'.repeat(42) + '"]').click();
    await vi.waitFor(() => expect(app.state.detail).toBeTruthy());
    container.querySelector('.wiki-link').click();
    expect(toast).toContain('未找到对应笔记');
    // 停留在当前笔记。
    expect(app.state.detail.id).toBe('d' + '0'.repeat(42));
  });

  it('shows backlinks (which notes reference the current one) and jumps on tap', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });

    // A 引用 B；C 也引用 B → B 的反向链接应有 A 和 C。
    const bodies = ['# 甲\n\n见 [[乙]]。', '# 乙\n\n正文。', '# 丙\n\n参见 [[乙]] 与 [[丁]]。'];
    const paths = ['wiki/甲.md', 'wiki/乙.md', 'wiki/丙.md'];
    const entries = paths.map((relativePath, i) => ({
      id: 'd' + String(i).padStart(42, '0'),
      relativePath,
      kind: 'document',
      mime: 'text/markdown; charset=utf-8',
      size: bodies[i].length,
      mtime: '2026-08-18T00:00:00Z',
      sha256: 'h' + String(i).padStart(63, '0'),
      title: relativePath.split('/')[1].replace('.md', ''),
    }));
    const manifest = {
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00Z',
      revision: 'r' + 'c'.repeat(63),
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
      randomImpl: () => 0,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });

    // 打开「乙」：反向链接应包含「甲」和「丙」。
    const idB = 'd' + '1'.padStart(42, '0');
    const idC = 'd' + '2'.padStart(42, '0');
    container.querySelector('[data-open="' + idB + '"]').click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(idB));
    expect(app.state.detail.backlinks.map((b) => b.id).sort()).toEqual([idB.replace('1', '0'), idC].sort());
    const blText = container.querySelector('#detail-backlinks').textContent;
    expect(blText).toContain('甲');
    expect(blText).toContain('丙');

    // 点击反向链接「丙」→ 跳转。
    container.querySelector('#detail-backlinks [data-open="' + idC + '"]').click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(idC));
  });

  it('jumps via [[S003]]-style source-number links to S-prefixed notes', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });

    const bodies = ['# 来源引用\n\n见 [[S003]] 的结论。', '# S003 静电纺丝\n\n正文。'];
    const paths = ['wiki/来源引用.md', 'raw/S003-静电纺丝综述.md'];
    const entries = paths.map((relativePath, i) => ({
      id: 'd' + String(i).padStart(42, '0'),
      relativePath,
      kind: 'document',
      mime: 'text/markdown; charset=utf-8',
      size: bodies[i].length,
      mtime: '2026-08-18T00:00:00Z',
      sha256: 'h' + String(i).padStart(63, '0'),
      title: relativePath.split('/')[1].replace('.md', ''),
    }));
    const manifest = {
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00Z',
      revision: 'r' + 'b'.repeat(63),
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
      randomImpl: () => 0,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });

    const idWiki = 'd' + '0'.repeat(42);
    const idSource = 'd' + '1'.padStart(42, '0');
    container.querySelector('[data-open="' + idWiki + '"]').click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(idWiki));

    const link = container.querySelector('.wiki-link');
    expect(link.getAttribute('data-wiki-target')).toBe('S003');
    link.click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(idSource));
    expect(container.querySelector('#detail-title').textContent).toContain('静电纺丝');
  });

  it('back from a wiki-link jump returns to the previous note, not home', async () => {
    const { window } = dom;
    const container = window.document.getElementById('screen');
    const adapter = createWebAdapter();
    const store = createConnectionStore(adapter);
    await store.save({ baseUrl: VALID_BASE, token: FAKE_TOKEN });

    const bodies = ['# 甲\n\n见 [[乙]]。', '# 乙\n\n正文。'];
    const paths = ['wiki/甲.md', 'wiki/乙.md'];
    const entries = paths.map((relativePath, i) => ({
      id: 'd' + String(i).padStart(42, '0'),
      relativePath,
      kind: 'document',
      mime: 'text/markdown; charset=utf-8',
      size: bodies[i].length,
      mtime: '2026-08-18T00:00:00Z',
      sha256: 'h' + String(i).padStart(63, '0'),
      title: relativePath.split('/')[1].replace('.md', ''),
    }));
    const manifest = {
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00Z',
      revision: 'r' + 'a'.repeat(63),
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
      randomImpl: () => 0,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });

    const idA = 'd' + '0'.repeat(42);
    const idB = 'd' + '1'.padStart(42, '0');

    // 打开甲 → 双链跳到乙。
    container.querySelector('[data-open="' + idA + '"]').click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(idA));
    container.querySelector('.wiki-link').click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(idB));

    // 返回 → 回到甲（而不是直接退出详情回首页）。
    container.querySelector('#detail-back').click();
    await vi.waitFor(() => expect(app.state.detail?.id).toBe(idA));
    expect(container.querySelector('#detail-title').textContent).toContain('甲');

    // 再返回 → 栈空，退出详情页。
    container.querySelector('#detail-back').click();
    await vi.waitFor(() => expect(app.state.detail).toBeNull());
  });
});
