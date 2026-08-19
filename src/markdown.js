/**
 * Markdown rendering (Task 6).
 *
 * renderMarkdown(markdown) → sanitized HTML string:
 * - marked 18 parses GitHub-flavored markdown (breaks off);
 * - DOMPurify sanitizes with an explicit tag/attribute allowlist (script,
 *   iframe, style, event handlers and every other non-allowlisted element or
 *   attribute are removed);
 * - every <a href> and <img src> is re-validated against an http(s)-or-
 *   relative URL policy; only http(s) links get target="_blank" +
 *   rel="noopener noreferrer", anything else loses its URL attribute.
 *
 * Relative links are deliberately left as-is — no target/rel, href kept
 * verbatim; resolving them against manifest artifact URLs happens later in
 * the UI batch, not here.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'br',
  'hr',
  'span',
  'del',
];

const ALLOWED_ATTRS = ['href', 'title', 'alt', 'src', 'class', 'data-wiki-target'];

/**
 * Obsidian 双链 `[[目标]]` / `[[目标|显示文本]]` → 可点击跳转链接。
 * 在 marked 之前替换（marked 保留内联 HTML，DOMPurify 再消毒）。
 * 目标名与显示文本均 HTML 转义；href 用 #wiki: 片段（相对引用，通过 URL 策略）。
 */
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function escHtmlAttr(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * URL policy: only http(s) URLs and relative references survive; javascript:,
 * data:, vbscript:, mailto:, tel: and protocol-relative (//host) URLs are
 * stripped. Relative references are kept verbatim.
 */
function isSafeUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.startsWith('//')) return false;
  let parsed;
  try {
    parsed = new URL(value, 'https://local.invalid/');
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true;
  // Anything that stays on the dummy base is a relative reference.
  return parsed.origin === 'https://local.invalid';
}

export function renderMarkdown(markdown) {
  const withWikiLinks = String(markdown ?? '').replace(WIKI_LINK_RE, (_m, target, label) => {
    const safeTarget = target.trim();
    const safeLabel = (label ?? target).trim() || safeTarget;
    return (
      '<a href="#wiki:' +
      encodeURIComponent(safeTarget) +
      '" class="wiki-link" data-wiki-target="' +
      escHtmlAttr(safeTarget) +
      '">' +
      escHtmlAttr(safeLabel) +
      '</a>'
    );
  });
  const raw = marked.parse(withWikiLinks, { gfm: true, breaks: false }) ?? '';
  const sanitized = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ALLOW_DATA_ATTR: ['data-wiki-target'],
  });

  // Enforce the URL policy and harden links after sanitization. Only http(s)
  // links are treated as external (target="_blank" + rel); relative links
  // keep their href verbatim and remain untouched.
  const document = new DOMParser().parseFromString(sanitized, 'text/html');
  for (const link of document.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (!isSafeUrl(href)) {
      link.removeAttribute('href');
      continue;
    }
    let parsed;
    try {
      parsed = new URL(href, 'https://local.invalid/');
    } catch {
      link.removeAttribute('href');
      continue;
    }
    // A link is external only when it resolves away from the dummy base:
    // absolute http(s) URLs change the origin, relative references stay on
    // it (their parsed protocol merely inherits the dummy https base).
    if (parsed.origin !== 'https://local.invalid') {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }
  for (const image of document.querySelectorAll('img[src]')) {
    if (!isSafeUrl(image.getAttribute('src'))) {
      image.removeAttribute('src');
    }
  }

  // 来源编号引用：[S024] / S024（知识库惯例）→ 可点击跳转到 S024-xxx 来源笔记。
  // 只在非链接的文本节点上处理（双链 [[…]] 已是 <a>，不嵌套）。
  const S_REF_RE = /\[(S0\d{2})\]|\b(S0\d{2})\b/g;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent && parent.closest('a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  let currentNode = walker.nextNode();
  while (currentNode !== null) {
    textNodes.push(currentNode);
    currentNode = walker.nextNode();
  }
  for (const node of textNodes) {
    const value = node.nodeValue ?? '';
    S_REF_RE.lastIndex = 0;
    let match = S_REF_RE.exec(value);
    if (match === null) continue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    S_REF_RE.lastIndex = 0;
    while ((match = S_REF_RE.exec(value)) !== null) {
      if (match.index > last) {
        fragment.appendChild(document.createTextNode(value.slice(last, match.index)));
      }
      const id = match[1] || match[2];
      const anchor = document.createElement('a');
      anchor.className = 'wiki-link';
      anchor.setAttribute('href', '#wiki:' + encodeURIComponent(id));
      anchor.setAttribute('data-wiki-target', id);
      anchor.textContent = id;
      fragment.appendChild(anchor);
      last = match.index + match[0].length;
    }
    if (last < value.length) {
      fragment.appendChild(document.createTextNode(value.slice(last)));
    }
    if (node.parentNode) node.parentNode.replaceChild(fragment, node);
  }

  return document.body.innerHTML;
}