import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';

describe('renderMarkdown — rendering', () => {
  it('renders GFM markdown to sanitized HTML (headings, lists, code, tables)', () => {
    const html = renderMarkdown(
      '# Hello\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    );
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
    // Language classes are stripped by the sanitizer (class is not an allowed
    // attribute), but the fenced code block itself renders fine.
    expect(html).toContain('<pre><code>const x = 1;');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders emphasis, links and images with allowed tags', () => {
    const html = renderMarkdown('**bold** and *italic* and ![alt](https://example.com/i.png)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<img src="https://example.com/i.png" alt="alt">');
  });
});

describe('renderMarkdown — XSS neutralization', () => {
  it('strips <script> blocks and event-handler attributes', () => {
    const html = renderMarkdown('<script>window.pwned = true</script>\n\n<p onclick="pwn()">safe</p>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('pwned');
    expect(html).not.toContain('onclick');
    expect(html).toContain('<p>safe</p>');
  });

  it('strips non-allowlisted attributes such as class, id, and style', () => {
    const html = renderMarkdown('<span class="danger" id="x" style="color:red">v</span>');
    expect(html).not.toContain('class=');
    expect(html).not.toContain('id=');
    expect(html).not.toContain('style=');
    expect(html).toContain('<span>v</span>');
  });

  it('neutralizes javascript: links', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a>click</a>');
    expect(html).not.toMatch(/<a[^>]+href/i);
  });

  it('strips raw <style> tags and inline style attributes', () => {
    const html = renderMarkdown('<style>body { color: red }</style>\n\n<span style="color: red">x</span>');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('color: red');
    expect(html).not.toContain('style=');
    expect(html).toContain('<span>x</span>');
  });

  it('removes iframes', () => {
    const html = renderMarkdown('<iframe src="https://evil.example.com/"></iframe>');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('evil.example.com');
  });

  it('drops event handlers from <img> and unsafe image sources', () => {
    const html = renderMarkdown('<img src="x.png" onerror="steal()"> ![ok](https://ok.example.com/i.png)');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('steal()');
    // The raw img keeps its relative src; the markdown image keeps its https src.
    expect(html).toContain('src="x.png"');
    expect(html).toContain('src="https://ok.example.com/i.png"');
  });

  it('drops data: URI image sources', () => {
    const html = renderMarkdown('![bad](data:image/png;base64,AAAA)');
    expect(html).not.toContain('data:image');
    expect(html).not.toMatch(/<img[^>]+src/i);
  });
});

describe('renderMarkdown — link attributes', () => {
  it('adds target=_blank and rel=noopener noreferrer to external https links', () => {
    const html = renderMarkdown('[docs](https://example.com/docs)');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps title attributes on links', () => {
    const html = renderMarkdown('[docs](https://example.com/docs "Read the docs")');
    expect(html).toContain('title="Read the docs"');
    expect(html).toContain('href="https://example.com/docs"');
  });

  it('leaves relative links untouched (manifest resolution happens later in the UI)', () => {
    const html = renderMarkdown('[note](notes/draft-01.md)');
    expect(html).toContain('href="notes/draft-01.md"');
  });

  it('strips hrefs that resolve to unexpected schemes (data:, mailto:)', () => {
    const html = renderMarkdown('[a](data:text/html,<b>hi</b>) [b](mailto:x@example.com)');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('mailto:');
    expect(html).not.toMatch(/<a[^>]+href/i);
  });
});