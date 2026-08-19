/**
 * Secure connection settings store (Batch 3).
 *
 * Stores the knowledge-base API base URL and the device token. Credentials
 * are persisted with @aparajita/capacitor-secure-storage on native Android
 * (key prefix `ua_kb_`), and kept only in memory on the web (never in
 * localStorage — this module performs no browser-storage access at all).
 *
 * The store is dependency-injected over an async adapter `{get, set, remove}`
 * so it can be unit-tested without a device. All validation failures and
 * wrapped adapter errors are generic and never include candidate secrets.
 */

export const KEY_PREFIX = 'ua_kb_';
export const BASE_URL_KEY = 'base_url';
export const DEVICE_TOKEN_KEY = 'device_token';
/** 手机内置助手的 LLM API Key（可选，独立于同步服务凭据）。 */
export const LLM_API_KEY = 'llm_api_key';

export const WEB_STORAGE_WARNING =
  'Web storage is development-only and unencrypted: connection settings are held in memory and are lost when the app closes.';

/** Exact format of issued device tokens. */
export const TOKEN_PATTERN = /^uak_[A-Za-z0-9_-]{43}$/;

const HTTP_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * True for loopback and private-network hostnames. Self-hosted LAN setups
 * (a phone on the same Wi-Fi reaching the server via http://192.168.x.x)
 * rely on this; public http hosts stay rejected.
 * 100.x is the CGNAT range used by Tailscale/ZeroTier virtual LANs, so a
 * phone can reach a self-hosted server over the tunnel as http://100.x.x.x.
 */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (HTTP_LOCAL_HOSTS.has(h) || h.endsWith('.local')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  // Tailscale / ZeroTier CGNAT 段 100.64.0.0/10（宽松匹配 100.x）。
  if (/^100\.\d+\.\d+\.\d+$/.test(h)) return true;
  return false;
}

/**
 * Normalizes a base URL (removes the trailing slash) and validates it.
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function normalizeBaseUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'base URL is required' };
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: 'base URL must be a valid absolute URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'base URL must use http or https' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'base URL must not include credentials' };
  }
  if (url.hash !== '') {
    return { ok: false, error: 'base URL must not include a fragment' };
  }
  if (url.search !== '') {
    return { ok: false, error: 'base URL must not include a query string' };
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    return { ok: false, error: 'insecure http is only allowed for local or private-network hosts' };
  }

  let value = url.origin;
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '') value += pathname;
  return { ok: true, value };
}

/**
 * Validates a device token against the mandated format.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateToken(value) {
  if (typeof value !== 'string' || value === '') {
    return { ok: false, error: 'device token is required' };
  }
  if (!TOKEN_PATTERN.test(value)) {
    return { ok: false, error: 'device token format is invalid' };
  }
  return { ok: true };
}

/**
 * Validates an LLM API key (optional setting). Empty/undefined is valid
 * (not configured); a non-empty value must look like a bearer key (sk-…).
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateLlmApiKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: true };
  }
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 256) {
    return { ok: false, error: 'API Key 长度应在 8–256 字符之间' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || !trimmed.startsWith('sk')) {
    return { ok: false, error: 'API Key 格式不正确（应以 sk 开头）' };
  }
  return { ok: true };
}

function unconfiguredState() {
  return { configured: false, baseUrl: null, tokenPresent: false, token: null, llmApiKey: null };
}

/**
 * Creates a connection settings store over an injected async adapter.
 * The adapter receives the unprefixed key names (`base_url`, `device_token`);
 * the native adapter applies the `ua_kb_` prefix via SecureStorage.setKeyPrefix.
 */
export function createConnectionStore(adapter) {
  async function save({ baseUrl, token, llmApiKey }) {
    const urlResult = normalizeBaseUrl(baseUrl);
    if (!urlResult.ok) {
      throw new TypeError(urlResult.error);
    }
    const tokenResult = validateToken(token);
    if (!tokenResult.ok) {
      throw new TypeError(tokenResult.error);
    }
    const keyResult = validateLlmApiKey(llmApiKey);
    if (!keyResult.ok) {
      throw new TypeError(keyResult.error);
    }
    try {
      await adapter.set(BASE_URL_KEY, urlResult.value);
      await adapter.set(DEVICE_TOKEN_KEY, token);
      // llmApiKey 为 undefined 表示保持不变；字符串（可为空）表示覆盖/清除。
      if (llmApiKey !== undefined) {
        if (typeof llmApiKey === 'string' && llmApiKey.trim() !== '') {
          await adapter.set(LLM_API_KEY, llmApiKey.trim());
        } else {
          await adapter.remove(LLM_API_KEY);
        }
      }
    } catch {
      // Best-effort cleanup on a failed save so no readable configured or
      // secret state remains. The secret key is removed first; cleanup
      // failures are swallowed and the adapter exception never surfaces.
      //
      // Both keys — not only the values written this call — are removed. A
      // transient keystore error means the adapter may have partially
      // persisted either write, so the store cannot trust that previously
      // saved valid settings are still intact. Removing them too is the
      // fail-closed choice: previously saved credentials are deliberately
      // destroyed (the user simply re-enters them) rather than risk a later
      // load pairing a stale credential with an absent/mismatched one.
      try {
        await adapter.remove(DEVICE_TOKEN_KEY);
      } catch {
        // Ignore cleanup failure.
      }
      try {
        await adapter.remove(BASE_URL_KEY);
      } catch {
        // Ignore cleanup failure.
      }
      throw new Error('failed to persist connection settings');
    }
  }

  async function load() {
    let rawUrl;
    let rawToken;
    let rawLlmKey;
    try {
      rawUrl = await adapter.get(BASE_URL_KEY);
      rawToken = await adapter.get(DEVICE_TOKEN_KEY);
      rawLlmKey = await adapter.get(LLM_API_KEY);
    } catch {
      // Fail closed on adapter read errors: reported as unconfigured.
      return unconfiguredState();
    }
    const urlResult = typeof rawUrl === 'string' ? normalizeBaseUrl(rawUrl) : { ok: false };
    const tokenResult = typeof rawToken === 'string' ? validateToken(rawToken) : { ok: false };
    const configured = urlResult.ok && tokenResult.ok;
    return {
      configured,
      // Fail closed: unless the full pair is valid, expose neither the base
      // URL nor the token.
      baseUrl: configured ? urlResult.value : null,
      tokenPresent: configured,
      token: configured ? rawToken : null,
      // 助手 API Key 独立于同步连接：有值即返回，格式不合法则视为未配置。
      llmApiKey:
        typeof rawLlmKey === 'string' && validateLlmApiKey(rawLlmKey).ok ? rawLlmKey : null,
    };
  }

  async function clear() {
    // Secret key first so a failure removing the base URL cannot leave the
    // device token readable.
    try {
      await adapter.remove(DEVICE_TOKEN_KEY);
    } catch {
      throw new Error('failed to clear connection settings');
    }
    try {
      await adapter.remove(BASE_URL_KEY);
    } catch {
      throw new Error('failed to clear connection settings');
    }
    try {
      await adapter.remove(LLM_API_KEY);
    } catch {
      throw new Error('failed to clear connection settings');
    }
  }

  async function publicStatus() {
    const state = await load();
    return {
      configured: state.configured,
      baseUrl: state.baseUrl,
      tokenPresent: state.tokenPresent,
    };
  }

  return { save, load, clear, publicStatus };
}

/**
 * In-memory adapter for web/development use. Never touches localStorage or
 * any persistent browser storage; keys are stored under the `ua_kb_` prefix
 * in memory so the storage scheme matches the native layout.
 */
export function createWebAdapter() {
  const memory = new Map();
  const fullKey = (key) => KEY_PREFIX + key;
  return {
    async get(key) {
      const k = fullKey(key);
      return memory.has(k) ? memory.get(k) : null;
    },
    async set(key, value) {
      memory.set(fullKey(key), value);
    },
    async remove(key) {
      memory.delete(fullKey(key));
    },
  };
}

/**
 * Adapter backed by @aparajita/capacitor-secure-storage (Android Keystore).
 * Sets the `ua_kb_` key prefix once and forwards the unprefixed key names.
 */
export async function createNativeAdapter() {
  const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
  await SecureStorage.setKeyPrefix(KEY_PREFIX);
  return {
    async get(key) {
      const value = await SecureStorage.get(key);
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      await SecureStorage.set(key, value);
    },
    async remove(key) {
      await SecureStorage.remove(key);
    },
  };
}

/**
 * Production factory: native secure storage on Android, in-memory on the web.
 * The returned store additionally exposes `storageWarning` when on the web.
 */
export async function createProductionConnectionStore({ isNative } = {}) {
  let useNative = isNative;
  if (useNative === undefined || useNative === null) {
    const { Capacitor } = await import('@capacitor/core');
    useNative = Capacitor.getPlatform() !== 'web';
  }
  const adapter = useNative ? await createNativeAdapter() : createWebAdapter();
  const store = createConnectionStore(adapter);
  return { ...store, storageWarning: useNative ? null : WEB_STORAGE_WARNING };
}