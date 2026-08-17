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
