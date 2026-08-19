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
    expect(html).toContain('<pre><code');
    expect(html).toContain('const x = 1;');
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

  it('strips non-allowlisted attributes such as id and style, but keeps class for wiki links', () => {
    const html = renderMarkdown('<span class="danger" id="x" style="color:red">v</span>');
    // class 已允许（用于 .wiki-link 双链样式）；id/style 仍剥离。
    expect(html).toContain('class="danger"');
    expect(html).not.toContain('id=');
    expect(html).not.toContain('style=');
    expect(html).toContain('<span class="danger">v</span>');
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

  it('leaves relative links untouched (no target/rel; manifest resolution happens later in the UI)', () => {
    const html = renderMarkdown('[note](notes/draft-01.md)');
    expect(html).toContain('href="notes/draft-01.md"');
    // The "left as-is" contract: relative links are not treated as external
    // and must NOT be opened in a new tab.
    expect(html).not.toContain('target=');
    expect(html).not.toContain('rel=');
    expect(html).not.toContain('noopener');
  });

  it('strips hrefs that resolve to unexpected schemes (data:, mailto:)', () => {
    const html = renderMarkdown('[a](data:text/html,<b>hi</b>) [b](mailto:x@example.com)');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('mailto:');
    expect(html).not.toMatch(/<a[^>]+href/i);
  });
});

describe('renderMarkdown — Obsidian 双链', () => {
  it('turns [[目标]] into a clickable wiki link with the target preserved', () => {
    const html = renderMarkdown('见 [[知识库运行协议]] 的说明。');
    expect(html).toContain('class="wiki-link"');
    expect(html).toContain('data-wiki-target="知识库运行协议"');
    expect(html).toContain('href="#wiki:');
    expect(html).toContain('>知识库运行协议</a>');
  });

  it('supports the alias form [[目标|显示文本]]', () => {
    const html = renderMarkdown('参考 [[UA知识库Android APK构建记录|构建记录]]。');
    expect(html).toContain('data-wiki-target="UA知识库Android APK构建记录"');
    expect(html).toContain('>构建记录</a>');
  });

  it('keeps injected markup trapped inside the attribute value (no element escapes)', () => {
    const html = renderMarkdown('[[<img src=x onerror=alert(1)>|<b>粗</b>]]');
    // 目标字符串可能以字面量形式出现在 data-wiki-target 属性值里（DOMPurify
    // 会解码实体），但属性值上下文不会形成元素，onerror 不可执行。
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('b')).toBeNull();
    expect(doc.querySelector('.wiki-link')).toBeTruthy();
    // label 的 <b> 只作为文本内容存在（不是元素）。
    expect(doc.querySelector('.wiki-link').textContent).toContain('粗');
    expect(doc.querySelector('.wiki-link').textContent).toContain('<b>');
    expect(doc.querySelector('.wiki-link').getAttribute('data-wiki-target')).toContain('<img');
  });

  it('keeps ordinary markdown links untouched', () => {
    const html = renderMarkdown('[普通链接](https://example.com) [[内部笔记]]');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('wiki-link');
  });

  it('turns [S0xx] bracket source-number refs into clickable wiki links', () => {
    const html = renderMarkdown('结论见 [S041] 与 [S024]。');
    expect(html).toContain('data-wiki-target="S041"');
    expect(html).toContain('data-wiki-target="S024"');
    expect(html).not.toContain('[S041]');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('.wiki-link').length).toBe(2);
  });

  it('turns bare S0xx numbers into wiki links without touching surrounding words', () => {
    const html = renderMarkdown('来源 S041 是 derivative。S024 与 S054 属 ASR 转写。');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('.wiki-link').length).toBe(3);
    expect(doc.querySelectorAll('.wiki-link')[0].textContent).toBe('S041');
    // 普通句子文本保留。
    expect(doc.body.textContent).toContain('是 derivative');
  });

  it('does not nest wiki links (double-bracket already consumed, S refs stay in text nodes)', () => {
    const html = renderMarkdown('见 [[S041|编号 S041 的笔记]]。');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // 双链生成一个 wiki-link；锚文本里的 S041 不再生成嵌套链接。
    expect(doc.querySelectorAll('a.wiki-link a.wiki-link').length).toBe(0);
    expect(doc.querySelectorAll('a.wiki-link').length).toBe(1);
    expect(doc.querySelector('a.wiki-link').getAttribute('data-wiki-target')).toBe('S041');
  });
});