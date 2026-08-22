/**
 * Build a deterministic, read-only folder tree from manifest relative paths.
 * The tree mirrors the computer vault hierarchy without inventing category
 * buckets or flattening nested directories.
 */

function compareByName(a, b) {
  return String(a.name ?? a.relativePath).localeCompare(String(b.name ?? b.relativePath), 'zh-CN');
}

export function buildFolderTree(entries = []) {
  const root = { name: '知识库', path: '', count: 0, folders: [], files: [] };
  const byPath = new Map([['', root]]);

  for (const entry of entries) {
    const relativePath = typeof entry?.relativePath === 'string' ? entry.relativePath : '';
    if (!relativePath) continue;
    const segments = relativePath.split('/');
    const fileName = segments.pop();
    let parent = root;
    let currentPath = '';
    for (const name of segments) {
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      let folder = byPath.get(currentPath);
      if (!folder) {
        folder = { name, path: currentPath, count: 0, folders: [], files: [] };
        byPath.set(currentPath, folder);
        parent.folders.push(folder);
      }
      parent = folder;
    }
    parent.files.push({ ...entry, name: fileName });
  }

  function finalize(node) {
    node.folders.sort(compareByName);
    node.files.sort((a, b) => String(a.relativePath).localeCompare(String(b.relativePath), 'zh-CN'));
    node.count = node.files.length + node.folders.reduce((sum, folder) => sum + finalize(folder), 0);
    return node.count;
  }
  finalize(root);
  Object.defineProperty(root, '_byPath', { value: byPath, enumerable: false });
  return root;
}

export function findFolder(tree, folderPath = '') {
  if (!tree) return null;
  const normalized = String(folderPath ?? '').replace(/^\/+|\/+$/g, '');
  if (tree._byPath instanceof Map) return tree._byPath.get(normalized) ?? null;
  if (normalized === '') return tree;
  let node = tree;
  for (const segment of normalized.split('/')) {
    node = node.folders?.find((folder) => folder.name === segment);
    if (!node) return null;
  }
  return node;
}

export function documentsDirectlyIn(entries = [], folderPath = '') {
  const prefix = folderPath ? `${folderPath}/` : '';
  return entries
    .filter((entry) => {
      if (entry?.kind !== 'document' || typeof entry.relativePath !== 'string') return false;
      const rest = entry.relativePath.slice(prefix.length);
      return entry.relativePath.startsWith(prefix) && rest !== '' && !rest.includes('/');
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

export function folderBreadcrumbs(folderPath = '') {
  const segments = String(folderPath ?? '').split('/').filter(Boolean);
  const crumbs = [{ label: '知识库', path: '' }];
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}
