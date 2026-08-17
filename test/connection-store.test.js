import { describe, it, expect } from 'vitest';
import {
  KEY_PREFIX,
  BASE_URL_KEY,
  DEVICE_TOKEN_KEY,
  WEB_STORAGE_WARNING,
  normalizeBaseUrl,
  validateToken,
  createConnectionStore,
  createWebAdapter,
  createProductionConnectionStore,
} from '../src/connection-store.js';

/**
 * Test-only fake device token: valid shape per the production pattern,
 * generated in test source so it can never be confused with a real issued secret.
 */
function fakeToken() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let body = '';
  for (let i = 0; i < 43; i += 1) body += alphabet[i % alphabet.length];
  return 'uak_' + body;
}

const FAKE_TOKEN = fakeToken();

/** Dependency-injected recorder adapter used to assert key names and error redaction. */
function spyAdapter() {
  const data = new Map();
  const calls = { get: [], set: [], remove: [] };
  const adapter = {
    calls,
    data,
    async get(key) {
      calls.get.push(key);
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value) {
      calls.set.push([key, value]);
      data.set(key, value);
    },
    async remove(key) {
      calls.remove.push(key);
      data.delete(key);
    },
  };
  return adapter;
}

function storeWith(adapter) {
  return createConnectionStore(adapter);
}

describe('exported constants', () => {
  it('exposes the mandated key prefix and key names', () => {
    expect(KEY_PREFIX).toBe('ua_kb_');
    expect(BASE_URL_KEY).toBe('base_url');
    expect(DEVICE_TOKEN_KEY).toBe('device_token');
    expect(`${KEY_PREFIX}${BASE_URL_KEY}`).toBe('ua_kb_base_url');
    expect(`${KEY_PREFIX}${DEVICE_TOKEN_KEY}`).toBe('ua_kb_device_token');
  });

  it('exposes a public web-storage warning', () => {
    expect(typeof WEB_STORAGE_WARNING).toBe('string');
    expect(WEB_STORAGE_WARNING.length).toBeGreaterThan(0);
  });
});

describe('normalizeBaseUrl', () => {
  it('normalizes a valid https URL and strips the trailing slash', () => {
    expect(normalizeBaseUrl('https://api.example.com/kb/')).toEqual({
      ok: true,
      value: 'https://api.example.com/kb',
    });
    expect(normalizeBaseUrl('https://api.example.com')).toEqual({
      ok: true,
      value: 'https://api.example.com',
    });
  });

  it('allows http only for localhost/127.0.0.1 with an optional explicit port', () => {
    expect(normalizeBaseUrl('http://localhost:8080/kb/')).toEqual({
      ok: true,
      value: 'http://localhost:8080/kb',
    });
    expect(normalizeBaseUrl('http://127.0.0.1:5173')).toEqual({
      ok: true,
      value: 'http://127.0.0.1:5173',
    });
    expect(normalizeBaseUrl('http://example.com')).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it('rejects non-http(s) schemes and malformed URLs', () => {
    expect(normalizeBaseUrl('ftp://example.com')).toEqual({ ok: false, error: expect.any(String) });
    expect(normalizeBaseUrl('example.com')).toEqual({ ok: false, error: expect.any(String) });
    expect(normalizeBaseUrl('https://')).toEqual({ ok: false, error: expect.any(String) });
    expect(normalizeBaseUrl('')).toEqual({ ok: false, error: expect.any(String) });
    expect(normalizeBaseUrl(null)).toEqual({ ok: false, error: expect.any(String) });
  });

  it('rejects URLs that embed credentials', () => {
    expect(normalizeBaseUrl('https://user:pass@example.com')).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(normalizeBaseUrl('https://user@example.com')).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it('rejects URLs with a fragment', () => {
    expect(normalizeBaseUrl('https://example.com/kb#section')).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it('rejects URLs with a query string', () => {
    expect(normalizeBaseUrl('https://example.com/kb?token=abc')).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(normalizeBaseUrl('https://example.com/kb/?refresh=1')).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it('never includes the candidate value in error messages', () => {
    const evil = 'https://user:secret@evil.example.com/';
    const { error } = normalizeBaseUrl(evil);
    expect(error).not.toContain('secret');
    expect(error).not.toContain('evil');
  });
});

describe('validateToken', () => {
  it('accepts a token of the exact mandated shape', () => {
    expect(validateToken(FAKE_TOKEN)).toEqual({ ok: true });
  });

  it('rejects wrong-length bodies', () => {
    expect(validateToken('uak_' + 'a'.repeat(42))).toEqual({ ok: false, error: expect.any(String) });
    expect(validateToken('uak_' + 'a'.repeat(44))).toEqual({ ok: false, error: expect.any(String) });
  });

  it('rejects invalid characters', () => {
    expect(validateToken('uak_' + ('a'.repeat(42) + '+'))).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(validateToken('uak_' + ('a'.repeat(42) + '='))).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(validateToken('uak_' + ('a'.repeat(42) + '/'))).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(validateToken('uak_' + ('a'.repeat(42) + ' '))).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it('rejects a wrong prefix and empty values', () => {
    expect(validateToken('tok_' + 'a'.repeat(43))).toEqual({ ok: false, error: expect.any(String) });
    expect(validateToken('')).toEqual({ ok: false, error: expect.any(String) });
    expect(validateToken(null)).toEqual({ ok: false, error: expect.any(String) });
  });

  it('never includes the candidate token in error messages', () => {
    const evil = 'uak_' + 'a'.repeat(42) + '+'; // valid prefix/length, invalid trailing char
    const { error } = validateToken(evil);
    expect(error).not.toContain(evil);
    expect(error).not.toContain('uak_');
    expect(error).toContain('token');
  });
});

describe('createConnectionStore', () => {
  it('saves, loads and clears both fields via the injected adapter using the public token name', async () => {
    const adapter = spyAdapter();
    const store = storeWith(adapter);

    await store.save({ baseUrl: 'https://api.example.com/kb/', token: FAKE_TOKEN });
    expect(adapter.calls.set).toEqual([
      [BASE_URL_KEY, 'https://api.example.com/kb'],
      [DEVICE_TOKEN_KEY, FAKE_TOKEN],
    ]);

    const loaded = await store.load();
    expect(loaded).toEqual({
      configured: true,
      baseUrl: 'https://api.example.com/kb',
      tokenPresent: true,
      token: FAKE_TOKEN,
    });
    expect(loaded.deviceToken).toBeUndefined();

    await store.clear();
    // Secret token key must be removed before the base URL.
    expect(adapter.calls.remove).toEqual([DEVICE_TOKEN_KEY, BASE_URL_KEY]);
    expect(await store.load()).toEqual({
      configured: false,
      baseUrl: null,
      tokenPresent: false,
      token: null,
    });
  });

  it('validates and stores the normalized base URL', async () => {
    const adapter = spyAdapter();
    const store = storeWith(adapter);
    await store.save({ baseUrl: 'https://api.example.com///', token: FAKE_TOKEN });
    expect(adapter.data.get(BASE_URL_KEY)).toBe('https://api.example.com');
  });

  it('rejects saving an invalid base URL or token without leaking values', async () => {
    const adapter = spyAdapter();
    const store = storeWith(adapter);

    await expect(store.save({ baseUrl: 'http://example.com', token: FAKE_TOKEN })).rejects.toThrow(
      /http/i,
    );
    await expect(store.save({ baseUrl: 'https://api.example.com', token: 'bad-token' })).rejects.toThrow(
      /token/i,
    );
    expect(adapter.calls.set).toHaveLength(0);
  });

  it('fails closed on partial adapter state (no token -> full unconfigured, baseUrl hidden)', async () => {
    const adapter = spyAdapter();
    await adapter.set(BASE_URL_KEY, 'https://api.example.com');
    const store = storeWith(adapter);
    expect(await store.load()).toEqual({
      configured: false,
      baseUrl: null,
      tokenPresent: false,
      token: null,
    });
  });

  it('fails closed on corrupt stored state (invalid token -> full unconfigured, baseUrl hidden)', async () => {
    const adapter = spyAdapter();
    await adapter.set(BASE_URL_KEY, 'https://api.example.com');
    await adapter.set(DEVICE_TOKEN_KEY, 'not-a-valid-token');
    const store = storeWith(adapter);
    expect(await store.load()).toEqual({
      configured: false,
      baseUrl: null,
      tokenPresent: false,
      token: null,
    });
  });

  it('surfaces adapter write errors as fixed generic errors with no cause or token', async () => {
    const adapterError = new Error(`write boom token=${FAKE_TOKEN}`);
    const store = storeWith({
      get: async () => null,
      set: async () => {
        throw adapterError;
      },
      remove: async () => {},
    });
    const error = await store
      .save({ baseUrl: 'https://api.example.com', token: FAKE_TOKEN })
      .then(
        () => null,
        (e) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('failed to persist connection settings');
    expect(error).not.toBe(adapterError);
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(error.stack).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);
    for (const key of Object.keys(error)) {
      expect(String(error[key])).not.toContain(FAKE_TOKEN);
    }
  });

  it('best-effort cleans up both keys when the token write fails, leaving no readable state', async () => {
    const adapter = spyAdapter();
    const store = createConnectionStore({
      get: adapter.get,
      set: async (key, value) => {
        if (key === DEVICE_TOKEN_KEY) {
          throw new Error(`token write boom ${FAKE_TOKEN}`);
        }
        await adapter.set(key, value);
      },
      remove: adapter.remove,
    });
    const error = await store
      .save({ baseUrl: 'https://api.example.com/kb/', token: FAKE_TOKEN })
      .then(
        () => null,
        (e) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('failed to persist connection settings');
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(error.stack).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);

    // Cleanup must have removed both keys (token first), so no configured/secret state remains.
    expect(adapter.calls.remove[0]).toBe(DEVICE_TOKEN_KEY);
    expect(adapter.calls.remove).toContain(BASE_URL_KEY);
    expect(adapter.data.has(BASE_URL_KEY)).toBe(false);
    expect(adapter.data.has(DEVICE_TOKEN_KEY)).toBe(false);
    expect(await store.load()).toEqual({
      configured: false,
      baseUrl: null,
      tokenPresent: false,
      token: null,
    });
  });

  it('a failed re-save deliberately removes previously saved valid settings (fail-closed destroys stale credentials)', async () => {
    const adapter = spyAdapter();
    // Previously saved, valid pair — as if an earlier save had succeeded.
    await adapter.set(BASE_URL_KEY, 'https://old.example.com');
    await adapter.set(DEVICE_TOKEN_KEY, FAKE_TOKEN);
    const store = createConnectionStore({
      get: adapter.get,
      set: async (key, value) => {
        if (key === DEVICE_TOKEN_KEY) {
          throw new Error('keystore write boom');
        }
        await adapter.set(key, value);
      },
      remove: adapter.remove,
    });
    const error = await store
      .save({ baseUrl: 'https://new.example.com/', token: FAKE_TOKEN })
      .then(
        () => null,
        (e) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('failed to persist connection settings');
    // Both keys are removed, including the previously saved valid pair: a
    // transient keystore error means the store cannot trust that the old
    // credentials survived intact, so they are deliberately destroyed and the
    // user re-enters them — no stale/mismatched pair can ever resurface.
    expect(adapter.calls.remove[0]).toBe(DEVICE_TOKEN_KEY);
    expect(adapter.calls.remove).toContain(BASE_URL_KEY);
    expect(adapter.data.has(BASE_URL_KEY)).toBe(false);
    expect(adapter.data.has(DEVICE_TOKEN_KEY)).toBe(false);
    expect(await store.load()).toEqual({
      configured: false,
      baseUrl: null,
      tokenPresent: false,
      token: null,
    });
  });

  it('does not leak cleanup errors when the failed-save cleanup removal throws', async () => {
    const adapter = spyAdapter();
    const store = createConnectionStore({
      get: adapter.get,
      set: async (key, value) => {
        if (key === DEVICE_TOKEN_KEY) {
          throw new Error(`token write boom ${FAKE_TOKEN}`);
        }
        await adapter.set(key, value);
      },
      remove: async (key) => {
        adapter.calls.remove.push(key);
        adapter.data.delete(key);
        if (key === DEVICE_TOKEN_KEY) {
          throw new Error(`cleanup removal boom ${FAKE_TOKEN}`);
        }
      },
    });
    const error = await store
      .save({ baseUrl: 'https://api.example.com/kb/', token: FAKE_TOKEN })
      .then(
        () => null,
        (e) => e,
      );
    // The cleanup failure must not surface: the caller still sees the fixed
    // generic error with no trace of the adapter exception or the token.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('failed to persist connection settings');
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(error.stack).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);
    // Cleanup stays best-effort: both keys were still attempted, token first,
    // and no readable state remains.
    expect(adapter.calls.remove[0]).toBe(DEVICE_TOKEN_KEY);
    expect(adapter.calls.remove).toContain(BASE_URL_KEY);
    expect(adapter.data.has(BASE_URL_KEY)).toBe(false);
    expect(adapter.data.has(DEVICE_TOKEN_KEY)).toBe(false);
    expect(await store.load()).toEqual({
      configured: false,
      baseUrl: null,
      tokenPresent: false,
      token: null,
    });
  });

  it('fails closed (no throw) when the adapter read errors, with redacted message', async () => {
    const store = storeWith({
      get: async () => {
        throw new Error('read boom with ' + FAKE_TOKEN);
      },
      set: async () => {},
      remove: async () => {},
    });
    const loaded = await store.load();
    expect(loaded).toEqual({
      configured: false,
      baseUrl: null,
      tokenPresent: false,
      token: null,
    });
    expect(JSON.stringify(loaded)).not.toContain(FAKE_TOKEN);
  });

  it('clears the token key before the base URL and redacts failures when the second removal fails', async () => {
    const removed = [];
    const store = createConnectionStore({
      get: async () => null,
      set: async () => {},
      remove: async (key) => {
        removed.push(key);
        if (key === BASE_URL_KEY) {
          throw new Error(`clear boom ${FAKE_TOKEN}`);
        }
      },
    });
    const error = await store.clear().then(
      () => null,
      (e) => e,
    );
    // Secret removal must be attempted first, so even if the base URL
    // removal fails the secret is already gone.
    expect(removed).toEqual([DEVICE_TOKEN_KEY, BASE_URL_KEY]);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('failed to clear connection settings');
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(error.stack).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);
  });

  it('publicStatus exposes only configured/baseUrl/tokenPresent and never the token', async () => {
    const store = storeWith(spyAdapter());
    await store.save({ baseUrl: 'https://api.example.com/kb/', token: FAKE_TOKEN });

    const status = await store.publicStatus();
    expect(Object.keys(status).sort()).toEqual(['baseUrl', 'configured', 'tokenPresent']);
    expect(status).toEqual({
      configured: true,
      baseUrl: 'https://api.example.com/kb',
      tokenPresent: true,
    });
    expect(status.token).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(store)).not.toContain(FAKE_TOKEN);
  });

  it('web adapter is memory-only and never touches browser storage', async () => {
    const storageOps = [];
    const storageProbe = {
      getItem: () => {
        storageOps.push('getItem');
        return null;
      },
      setItem: () => storageOps.push('setItem'),
      removeItem: () => storageOps.push('removeItem'),
      clear: () => storageOps.push('clear'),
      key: () => {
        storageOps.push('key');
        return null;
      },
      length: 0,
    };

    let storageReplaced = false;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        value: storageProbe,
        configurable: true,
        writable: true,
      });
      storageReplaced = true;
    } catch {
      // jsdom may not allow replacing window properties; skip the probe.
    }

    const store = storeWith(createWebAdapter());
    await store.save({ baseUrl: 'https://api.example.com/kb/', token: FAKE_TOKEN });
    const loaded = await store.load();
    expect(loaded).toEqual({
      configured: true,
      baseUrl: 'https://api.example.com/kb',
      tokenPresent: true,
      token: FAKE_TOKEN,
    });
    const status = await store.publicStatus();
    await store.clear();
    expect(await store.load()).toMatchObject({ configured: false });

    if (storageReplaced) {
      expect(storageOps).toHaveLength(0);
      expect(JSON.stringify(status)).not.toContain(FAKE_TOKEN);
    }
  });

  it('two web stores do not share memory (no accidental global persistence)', async () => {
    const storeA = storeWith(createWebAdapter());
    const storeB = storeWith(createWebAdapter());
    await storeA.save({ baseUrl: 'https://a.example.com', token: FAKE_TOKEN });
    expect(await storeB.load()).toMatchObject({ configured: false });
  });
});

describe('createProductionConnectionStore', () => {
  it('uses an in-memory adapter on the web and exposes the storage warning', async () => {
    const factory = await createProductionConnectionStore({ isNative: false });
    expect(factory.storageWarning).toBe(WEB_STORAGE_WARNING);
    await factory.save({ baseUrl: 'https://api.example.com/kb/', token: FAKE_TOKEN });
    expect(await factory.publicStatus()).toEqual({
      configured: true,
      baseUrl: 'https://api.example.com/kb',
      tokenPresent: true,
    });
    expect(JSON.stringify(await factory.publicStatus())).not.toContain(FAKE_TOKEN);
  });

  it('does not leak the token through serialization of a non-native store', async () => {
    const factory = await createProductionConnectionStore({ isNative: false });
    await factory.save({ baseUrl: 'https://api.example.com', token: FAKE_TOKEN });
    expect(JSON.stringify(factory)).not.toContain(FAKE_TOKEN);
  });
});