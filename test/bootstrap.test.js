import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppState } from '../src/main.js';

const mainSourcePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'main.js',
);

describe('createAppState() — baseline app state', () => {
  it('returns the exact baseline state object', () => {
    expect(createAppState()).toEqual({
      tab: 'home',
      query: '',
      syncing: false,
      activeRevision: null,
      connection: 'unconfigured',
      documents: [],
      artifacts: [],
    });
  });

  it('returns a fresh object on every call (no shared mutation)', () => {
    const first = createAppState();
    const second = createAppState();
    expect(first).not.toBe(second);
    first.documents.push('x');
    expect(second.documents).toEqual([]);
  });

  it('is importable through dynamic import with no network/credential actions', async () => {
    const mod = await import('../src/main.js');
    expect(typeof mod.createAppState).toBe('function');
    expect(mod.createAppState()).toEqual({
      tab: 'home',
      query: '',
      syncing: false,
      activeRevision: null,
      connection: 'unconfigured',
      documents: [],
      artifacts: [],
    });
  });

  it('module source performs no network, credential, or storage actions at top level', () => {
    const src = readFileSync(mainSourcePath, 'utf8');
    expect(src).not.toMatch(/fetch\s*\(/);
    expect(src).not.toMatch(/XMLHttpRequest/);
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    expect(src).not.toMatch(/Authorization|Bearer/i);
    expect(src).not.toMatch(/device.?token/i);
  });
});