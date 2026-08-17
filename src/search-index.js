/**
 * Local search index (Task 6) — a thin wrapper around MiniSearch 7 tuned for
 * Chinese-language knowledge bases.
 *
 * Tokenization:
 * - Latin words/numbers are lowercased and kept as single tokens;
 * - every contiguous CJK run is emitted as unigrams AND bigrams
 *   (知识库 → 知, 识, 库, 知识, 识库) so both single-character and
 *   two-character queries match;
 * - punctuation and whitespace split tokens.
 *
 * Fields: title (boost 3), body (boost 1), relativePath (boost 1);
 * storeFields: title, relativePath, id. The index is serializable per
 * manifest revision (serializeIndex/deserializeIndex) and is persisted in the
 * cache-db searchIndexes store by the sync layer later; this module only
 * provides the functions.
 */

import MiniSearch from 'minisearch';

const CJK_RUN = /^[\u4e00-\u9fff]+$/;
const SCAN_RE = /[A-Za-z0-9]+(?:[-_'][A-Za-z0-9]+)*|[\u4e00-\u9fff]+/g;

/** Pure tokenizer: lowercase Latin tokens + CJK unigram/bigram expansion. */
export function tokenizeCJK(text) {
  if (typeof text !== 'string' || text === '') return [];
  const tokens = [];
  for (const match of text.matchAll(SCAN_RE)) {
    const token = match[0];
    if (CJK_RUN.test(token)) {
      if (token.length === 1) {
        tokens.push(token);
        continue;
      }
      for (let i = 0; i < token.length; i += 1) tokens.push(token[i]);
      for (let i = 0; i < token.length - 1; i += 1) tokens.push(token.slice(i, i + 2));
    } else {
      tokens.push(token.toLowerCase());
    }
  }
  return tokens;
}

const MINI_SEARCH_OPTIONS = {
  idField: 'id',
  fields: ['title', 'body', 'relativePath'],
  storeFields: ['title', 'relativePath', 'id'],
  tokenize: tokenizeCJK,
  // MiniSearch 7 applies field boosts through searchOptions (the
  // constructor-level `boost` option is ignored by search()), so the title
  // boost is configured here to rank every query consistently.
  searchOptions: { boost: { title: 3, relativePath: 1 } },
};

export class KnowledgeSearchIndex {
  constructor(documents = []) {
    this.mini = new MiniSearch(MINI_SEARCH_OPTIONS);
    if (Array.isArray(documents) && documents.length > 0) this.addDocuments(documents);
  }

  addDocuments(documents) {
    this.mini.addAll(documents);
  }

  query(query, options = {}) {
    if (typeof query !== 'string' || query.trim() === '') return [];
    return this.mini.search(query, options);
  }

  /** Serialized index (a JSON string) for per-revision persistence. */
  serializeIndex() {
    return JSON.stringify(this.mini.toJSON());
  }

  /** Rebuilds an index instance from the serialized JSON string. */
  static fromSerialized(json) {
    const input = typeof json === 'string' ? json : JSON.stringify(json);
    const index = new KnowledgeSearchIndex();
    index.mini = MiniSearch.loadJSON(input, MINI_SEARCH_OPTIONS);
    return index;
  }
}

export function buildSearchIndex(documents) {
  return new KnowledgeSearchIndex(documents);
}

export function deserializeIndex(json) {
  return KnowledgeSearchIndex.fromSerialized(json);
}

/** Stateless convenience: build an index over documents and query it in one call. */
export const searchIndex = {
  query(query, documents) {
    return buildSearchIndex(documents ?? []).query(query);
  },
};