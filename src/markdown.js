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

const ALLOWED_ATTRS = ['href', 'title', 'alt', 'src'];

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
  const raw = marked.parse(markdown, { gfm: true, breaks: false }) ?? '';
  const sanitized = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ALLOW_DATA_ATTR: false,
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
  return document.body.innerHTML;
}