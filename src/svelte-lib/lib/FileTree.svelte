<script lang="ts">
  import { siteTree, type TreeNode } from '$lib/siteTree';

  interface Props { query: string; currentPath: string; }
  const { query, currentPath }: Props = $props();

  function matchesQuery(node: TreeNode, q: string): boolean {
    if (!q) return true;
    const lower = q.toLowerCase();
    if (node.name.toLowerCase().includes(lower)) return true;
    if (node.children) return node.children.some(c => matchesQuery(c, q));
    return false;
  }

  let openFolders: Record<string, boolean> = $state({});
  const toggle = (p: string) => { openFolders[p] = !openFolders[p]; };
  const filteredTree = $derived(query ? siteTree.filter(n => matchesQuery(n, query)) : siteTree);
</script>

<nav>
  {#each filteredTree as node}
    {#if node.children}
      <div style="padding-left: {node.depth * 12}px">
        <div class="tree-item"
          onclick={() => toggle(node.path)}
          onkeydown={e => e.key === 'Enter' && toggle(node.path)}
          role="button" tabindex="0">
          <span class="tree-folder-toggle">{openFolders[node.path] ? '▼' : '▶'}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span>{node.name}</span>
        </div>
        <div class="tree-children" class:open={openFolders[node.path] || !!query}>
          {#each (node.children ?? []) as child}
            {#if child.children}
              <div style="padding-left: {child.depth * 12}px">
                <div class="tree-item"
                  onclick={() => toggle(child.path)}
                  onkeydown={e => e.key === 'Enter' && toggle(child.path)}
                  role="button" tabindex="0">
                  <span class="tree-folder-toggle">{openFolders[child.path] ? '▼' : '▶'}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  <span>{child.name}</span>
                </div>
                <div class="tree-children" class:open={openFolders[child.path] || !!query}>
                  {#each (child.children ?? []) as leaf}
                    <a href={leaf.path} class="tree-item" class:active={currentPath === leaf.path}
                      style="padding-left: {leaf.depth * 12 + 8}px">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                      </svg>
                      <span>{leaf.name}</span>
                    </a>
                  {/each}
                </div>
              </div>
            {:else}
              <a href={child.path} class="tree-item" class:active={currentPath === child.path}
                style="padding-left: {child.depth * 12 + 8}px">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
                <span>{child.name}</span>
              </a>
            {/if}
          {/each}
        </div>
      </div>
    {:else}
      <a href={node.path} class="tree-item" class:active={currentPath === node.path}
        style="padding-left: {node.depth * 12 + 8}px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span>{node.name}</span>
      </a>
    {/if}
  {/each}
</nav>
