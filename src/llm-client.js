/**
 * 手机内置智能助手：直连 DeepSeek（OpenAI 兼容 chat completions）。
 *
 * 与同步服务完全解耦——用户在本机配置 LLM API Key（存系统安全存储）后，
 * 助手直接在手机上调 LLM，电脑/服务器关机也可用。
 *
 * 原生环境走 CapacitorHttp（Android 原生网络栈，无浏览器 CORS 限制）；
 * Web/测试环境走 fetch。所有上游交互经可注入 transport，测试不触网。
 */

import { CapacitorHttp } from '@capacitor/core';

export const DEFAULT_LLM_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_LLM_MODEL = 'deepseek-chat';
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const MAX_QUESTION_CHARS = 2_000;
export const MAX_KNOWLEDGE_CHUNKS = 10;
export const MAX_CHUNK_EXCERPT_CHARS = 1_000;
export const MAX_ANSWER_BYTES = 512 * 1024;

export class LlmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LlmError';
    this.code = code; // 'not_configured' | 'timeout' | 'upstream' | 'network' | 'parse'
  }
}

/** 与服务端 /v1/ask 相同的助手人设（来源标注规则）。 */
export function systemPrompt() {
  return (
    '你是「个人知识库」的智能助手。用户的知识库包含 wiki（长期知识）、outputs（任务产物）与 raw（原始证据）等 Markdown 笔记。\n' +
    '回答规则：\n' +
    '1. 优先依据下方提供的「知识片段」作答；每个片段标注了来源（相对路径）。\n' +
    '2. 引用知识片段时，在答案中标注来源，格式如（来源：wiki/xxx.md）。\n' +
    '3. 如果知识片段不足以回答，明确说明依据不足，再基于通用知识给出建议；不要编造片段中没有的内容。\n' +
    '4. 用中文回答，简洁、条理清晰。'
  );
}

function composeUserContent(question, knowledge) {
  const parts = [`问题：${question}`];
  if (knowledge.length > 0) {
    const chunks = knowledge
      .map((k, i) => `[${i + 1}] ${k.relativePath} — ${k.title}\n${k.excerpt}`)
      .join('\n\n');
    parts.push(`知识片段（来自用户知识库）：\n${chunks}`);
  }
  parts.push('请回答。');
  return parts.join('\n\n');
}

/** 原生传输：CapacitorHttp，无 CORS 限制。 */
async function nativeTransport({ endpoint, apiKey, messages, timeoutMs }) {
  const response = await CapacitorHttp.request({
    url: endpoint,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    data: { model: DEFAULT_LLM_MODEL, stream: false, temperature: 0.3, max_tokens: 2_000, messages },
    readTimeout: timeoutMs,
    connectTimeout: Math.min(timeoutMs, 15_000),
  });
  return {
    status: response.status,
    headers: response.headers ?? {},
    text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? ''),
  };
}

/** 浏览器/fetch 传输（Web 与测试）。 */
async function fetchTransport({ endpoint, apiKey, messages, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: DEFAULT_LLM_MODEL, stream: false, temperature: 0.3, max_tokens: 2_000, messages }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new LlmError('timeout', 'LLM 请求超时');
    throw new LlmError('network', 'LLM 网络请求失败');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

export function createLlmClient({
  apiKey,
  endpoint = DEFAULT_LLM_ENDPOINT,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  transport,
} = {}) {
  const useNative =
    typeof Capacitor !== 'undefined' && typeof Capacitor.getPlatform === 'function' && Capacitor.getPlatform() !== 'web';
  const request = transport ?? (useNative ? nativeTransport : fetchTransport);

  async function ask(question, knowledge = []) {
    if (!apiKey) {
      throw new LlmError('not_configured', '未配置助手 API Key');
    }
    const messages = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: composeUserContent(question, knowledge) },
    ];
    let response;
    try {
      response = await request({ endpoint, apiKey, messages, timeoutMs });
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError('network', 'LLM 请求失败');
    }
    if (typeof response.status === 'number' && (response.status < 200 || response.status >= 300)) {
      throw new LlmError('upstream', `LLM 服务返回 ${response.status}`);
    }
    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new LlmError('parse', 'LLM 响应无法解析');
    }
    const answer = extractAnswer(payload);
    if (answer === null) {
      throw new LlmError('parse', 'LLM 响应缺少有效答案');
    }
    return { answer };
  }

  return { ask };
}

/** 从 chat-completions payload 取第一条助手消息文本。 */
export function extractAnswer(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const root = payload;
  if (!Array.isArray(root.choices) || root.choices.length === 0) return null;
  const choice = root.choices[0];
  if (choice === null || typeof choice !== 'object') return null;
  const message = choice.message;
  if (message === null || typeof message !== 'object') return null;
  const content = message.content;
  return typeof content === 'string' && content.trim().length > 0 ? content : null;
}
