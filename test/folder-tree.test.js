import { describe, expect, it } from 'vitest';
import { buildFolderTree, findFolder, folderBreadcrumbs, documentsDirectlyIn } from '../src/folder-tree.js';

function entry(relativePath, kind = 'document') {
  return { id: relativePath, relativePath, kind, title: relativePath.split('/').pop() };
}

describe('folder-tree', () => {
  const entries = [
    entry('AGENTS.md'),
    entry('wiki/index.md'),
    entry('wiki/topic/a.md'),
    entry('raw/douyin/creator/video.md'),
    entry('outputs/app.apk', 'artifact'),
  ];

  it('recreates the complete relative folder hierarchy and recursive counts', () => {
    const root = buildFolderTree(entries);
    expect(root.folders.map((f) => f.path)).toEqual(['outputs', 'raw', 'wiki']);
    expect(findFolder(root, 'raw/douyin/creator')).toMatchObject({
      name: 'creator',
      path: 'raw/douyin/creator',
      count: 1,
    });
    expect(findFolder(root, 'wiki')).toMatchObject({ count: 2 });
    expect(root.files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
  });

  it('returns only documents directly inside the opened folder', () => {
    expect(documentsDirectlyIn(entries, '').map((e) => e.relativePath)).toEqual(['AGENTS.md']);
    expect(documentsDirectlyIn(entries, 'wiki').map((e) => e.relativePath)).toEqual(['wiki/index.md']);
    expect(documentsDirectlyIn(entries, 'outputs')).toEqual([]);
  });

  it('builds clickable breadcrumbs from root to the current folder', () => {
    expect(folderBreadcrumbs('raw/douyin/creator')).toEqual([
      { label: '知识库', path: '' },
      { label: 'raw', path: 'raw' },
      { label: 'douyin', path: 'raw/douyin' },
      { label: 'creator', path: 'raw/douyin/creator' },
    ]);
  });
});
