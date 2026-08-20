import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Capacitor edge-to-edge shell', () => {
  it('does not inset the WebView parent around system bars or display cutouts', () => {
    const config = JSON.parse(
      readFileSync(path.join(process.cwd(), 'capacitor.config.json'), 'utf8'),
    );
    const html = readFileSync(
      path.join(process.cwd(), 'www', 'index.html'),
      'utf8',
    );
    const viewport = html.match(
      /<meta\s+name="viewport"\s+content="([^"]+)"\s*\/?>/,
    );

    expect(config.plugins?.SystemBars?.insetsHandling).toBe('disable');
    expect(viewport?.[1]).toContain('viewport-fit=cover');
  });
});
