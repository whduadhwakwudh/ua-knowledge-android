import { describe, it, expect } from 'vitest';
import {
  buildSearchIndex,
  deserializeIndex,
  searchIndex,
  tokenizeCJK,
} from '../src/search-index.js';

describe('tokenizeCJK', () => {
  it('splits a CJK run into unigrams and bigrams', () => {
    expect(tokenizeCJK('知识库')).toEqual(['知', '识', '库', '知识', '识库']);
  });

  it('lowercases latin words and keeps them alongside CJK tokens', () => {
    expect(tokenizeCJK('Transformer 知识库 v2')).toEqual([
      'transformer',
      '知',
      '识',
      '库',
      '知识',
      '识库',
      'v2',
    ]);
  });

  it('splits a mixed run with no whitespace', () => {
    expect(tokenizeCJK('知识库v2')).toEqual(['知', '识', '库', '知识', '识库', 'v2']);
  });

  it('splits on punctuation and whitespace and ignores empties', () => {
    expect(tokenizeCJK('Note: 知识库, 2026!')).toEqual(['note', '知', '识', '库', '知识', '识库', '2026']);
  });
});

function doc(id, title, body, relativePath) {
  return { id, title, body, relativePath };
}

describe('buildSearchIndex / query', () => {
  it('matches a document that contains the query CJK term in its body', () => {
    const docs = [doc('sha-a', '说明', '这是知识库使用的说明文档', 'wiki/a.md')];
    const results = buildSearchIndex(docs).query('知识库');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('sha-a');
  });

  it('matches latin queries case-insensitively', () => {
    const docs = [doc('sha-t', 'Transformer 指南', '正文内容', 'wiki/t.md')];
    const index = buildSearchIndex(docs);
    expect(index.query('transformer').map((r) => r.id)).toContain('sha-t');
    expect(index.query('TRANSFORMER').map((r) => r.id)).toContain('sha-t');
  });

  it('ranks a title match above a body match', () => {
    const docs = [
      doc('title-doc', 'Transformer 架构解析', '与主题无关的填充正文。', 'wiki/t.md'),
      doc('body-doc', '其他文档', '文中反复提到 transformer，transformer 的关系。', 'wiki/b.md'),
    ];
    const results = buildSearchIndex(docs).query('transformer');
    expect(results[0].id).toBe('title-doc');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('matches through unigrams and bigrams of the same CJK doc', () => {
    const docs = [doc('sha-u', '说明', '知识库里介绍了用法', 'wiki/u.md')];
    const index = buildSearchIndex(docs);
    expect(index.query('知').map((r) => r.id)).toContain('sha-u'); // unigram
    expect(index.query('库里').map((r) => r.id)).toContain('sha-u'); // bigram
    expect(index.query('识库').map((r) => r.id)).toContain('sha-u'); // bigram
  });

  it('searches the relativePath field', () => {
    const docs = [doc('sha-r', '关于说明', '正文', 'wiki/transformer.md')];
    const results = buildSearchIndex(docs).query('transformer');
    expect(results[0]?.id).toBe('sha-r');
  });

  it('returns stored fields (title, relativePath, id) with every result', () => {
    const docs = [doc('sha-s', '标题', '知识库 内容', 'wiki/s.md')];
    const result = buildSearchIndex(docs).query('知识库')[0];
    expect(result).toMatchObject({ id: 'sha-s', title: '标题', relativePath: 'wiki/s.md' });
  });

  it('returns no results for an empty query without throwing', () => {
    const docs = [doc('sha-e', '标题', '知识库 内容', 'wiki/e.md')];
    expect(buildSearchIndex(docs).query('')).toEqual([]);
  });
});

describe('serializeIndex / deserializeIndex', () => {
  it('round-trips an index and preserves query results', () => {
    const docs = [
      doc('sha-a', 'Transformer 说明', '这是知识库的文档', 'wiki/a.md'),
      doc('sha-b', '其他', '完全不相关的内容', 'wiki/b.md'),
    ];
    const index = buildSearchIndex(docs);
    const json = index.serializeIndex();
    expect(typeof json).toBe('string');

    const restored = deserializeIndex(json);
    const before = index.query('知识库').map((r) => r.id);
    const after = restored.query('知识库').map((r) => r.id);
    expect(after).toEqual(before);
    expect(restored.query('transformer').map((r) => r.id)).toEqual(index.query('transformer').map((r) => r.id));
  });
});

describe('searchIndex convenience helper', () => {
  it('builds from documents and answers queries statelessly', () => {
    const docs = [doc('sha-x', '说明', '知识库使用手册', 'wiki/x.md')];
    const results = searchIndex.query('知识库', docs);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('sha-x');
  });
});