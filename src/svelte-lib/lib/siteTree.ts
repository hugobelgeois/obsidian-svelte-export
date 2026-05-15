export interface TreeNode {
  name: string;
  path: string;
  depth: number;
  children?: TreeNode[];
}

const modules = import.meta.glob('/src/routes/**/+page.svelte');

function buildTree(): TreeNode[] {
  const paths = Object.keys(modules)
    .map(p => p.replace('/src/routes', '').replace('/+page.svelte', '').replace(/\/$/, '') || '/')
    .filter(p => p !== '/');

  const root: TreeNode[] = [];

  for (const rawPath of paths.sort()) {
    const parts = rawPath.split('/').filter(Boolean);
    let currentLevel = root;

    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      const existing = currentLevel.find(n => n.name === part);
      const builtPath = '/' + parts.slice(0, i + 1).join('/');

      if (existing) {
        if (!isLeaf && !existing.children) existing.children = [];
        currentLevel = existing.children ?? [];
      } else {
        const node: TreeNode = {
          name: part,
          path: isLeaf ? builtPath + '/' : builtPath,
          depth: i + 1,
          children: isLeaf ? undefined : [],
        };
        currentLevel.push(node);
        currentLevel = node.children ?? [];
      }
    });
  }
  return root;
}

export const siteTree: TreeNode[] = buildTree();

export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (!node.children) result.push(node);
    else result.push(...flattenTree(node.children));
  }
  return result;
}
