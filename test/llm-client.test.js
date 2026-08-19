import { describe, expect, it } from 'vitest';
import { LlmError, createLlmClient, extractAnswer, systemPrompt } from '../src/llm-client.js';

/**
 * 手机内置助手（直连 DeepSeek）单测——transport 注入 mock，不触网。
 */

function okTransport(answer) {
  return async () => ({
    status: 200,
    headers: {},
    text: JSON.stringify({ choices: [{ message: { content: answer } }] }),
  });
}

function makeClient(opts = {}) {
  return createLlmClient({ apiKey: 'sk-test-key-12345', transport: okTransport('内置回答'), ...opts });
}

describe('createLlmClient — 手机内置助手', () => {
  it('returns the assistant message on success', async () => {
    const client = makeClient({ transport: okTransport('答案是 42。') });
    const result = await client.ask('答案？', []);
    expect(result.answer).toBe('答案是 42。');
  });

  it('throws not_configured when no API key is present', async () => {
    const client = createLlmClient({ transport: okTransport('x') });
    await expect(client.ask('hi', [])).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('sends question + knowledge chunks with source attribution in the user message', async () => {
    let captured = null;
    const client = createLlmClient({
      apiKey: 'sk-test-key-12345',
      transport: async ({ endpoint, apiKey, messages }) => {
        captured = { endpoint, apiKey, messages };
        return { status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    await client.ask('怎么同步？', [
      { title: '同步协议', excerpt: '指纹缓存 TTL 5 秒。', relativePath: 'wiki/同步协议.md' },
    ]);
    expect(captured.endpoint).toContain('chat/completions');
    expect(captured.apiKey).toBe('sk-test-key-12345');
    const user = captured.messages[1].content;
    expect(user).toContain('怎么同步？');
    expect(user).toContain('wiki/同步协议.md');
    expect(user).toContain('指纹缓存 TTL 5 秒。');
  });

  it('never includes knowledge when none is supplied', async () => {
    let userContent = '';
    const client = createLlmClient({
      apiKey: 'sk-test-key-12345',
      transport: async ({ messages }) => {
        userContent = messages[1].content;
        return { status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    await client.ask('hello', []);
    expect(userContent).not.toContain('知识片段');
  });

  it('interleaves conversation history between system and the current question', async () => {
    let captured = null;
    const client = createLlmClient({
      apiKey: 'sk-test-key-12345',
      transport: async ({ messages }) => {
        captured = messages;
        return { status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    const history = [
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '第一个回答' },
    ];
    await client.ask('追问', [], history);
    expect(captured.length).toBe(4); // system + 2 历史 + 当前问题
    expect(captured[0].role).toBe('system');
    expect(captured[1]).toEqual({ role: 'user', content: '第一个问题' });
    expect(captured[2]).toEqual({ role: 'assistant', content: '第一个回答' });
    expect(captured[3].role).toBe('user');
    expect(captured[3].content).toContain('追问');
  });

  it('filters malformed history items but keeps valid turns', async () => {
    let captured = null;
    const client = createLlmClient({
      apiKey: 'sk-test-key-12345',
      transport: async ({ messages }) => {
        captured = messages;
        return { status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    await client.ask('q', [], [
      { role: 'user', content: '有效历史' },
      { role: 'system', content: '非法角色应被过滤' },
      { role: 'assistant', content: '' },
      null,
      { role: 'assistant', content: '  ' },
    ]);
    expect(captured.length).toBe(3); // system + 1 有效历史 + 当前
    expect(captured[1]).toEqual({ role: 'user', content: '有效历史' });
  });

  it('re-throws LlmError from the transport (timeout)', async () => {
    const client = createLlmClient({
      apiKey: 'sk-test-key-12345',
      transport: async () => {
        throw new LlmError('timeout', 'LLM 请求超时');
      },
    });
    await expect(client.ask('hi', [])).rejects.toMatchObject({ code: 'timeout' });
  });

  it('wraps an unknown transport failure as network', async () => {
    const client = createLlmClient({
      apiKey: 'sk-test-key-12345',
      transport: async () => {
        throw new TypeError('boom');
      },
    });
    await expect(client.ask('hi', [])).rejects.toMatchObject({ code: 'network' });
  });

  it('maps a non-2xx upstream to upstream', async () => {
    const client = createLlmClient({
      apiKey: 'sk-test-key-12345',
      transport: async () => ({ status: 429, headers: {}, text: 'rate limited' }),
    });
    await expect(client.ask('hi', [])).rejects.toMatchObject({ code: 'upstream' });
  });

  it('maps unparseable or answer-less payloads to parse', async () => {
    for (const text of ['not json', JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: '' } }] })]) {
      const client = createLlmClient({
        apiKey: 'sk-test-key-12345',
        transport: async () => ({ status: 200, headers: {}, text }),
      });
      await expect(client.ask('hi', [])).rejects.toMatchObject({ code: 'parse' });
    }
  });
});

describe('extractAnswer', () => {
  it('returns the first assistant message content', () => {
    expect(extractAnswer({ choices: [{ message: { content: '甲' } }, { message: { content: '乙' } }] })).toBe('甲');
  });

  it('returns null for empty content or no choices', () => {
    expect(extractAnswer({ choices: [] })).toBeNull();
    expect(extractAnswer({ choices: [{ message: {} }] })).toBeNull();
    expect(extractAnswer(null)).toBeNull();
  });
});

describe('systemPrompt', () => {
  it('demands source attribution in Chinese', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('知识片段');
    expect(prompt).toContain('来源');
    expect(prompt).toContain('raw');
  });
});
