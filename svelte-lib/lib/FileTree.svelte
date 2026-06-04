<script lang="ts">
	import { siteTree, type TreeNode } from "$lib/siteTree";
	import { hiddenPaths } from "$lib/stores";

	interface Props {
		query: string;
		currentPath: string;
	}
	const { query, currentPath }: Props = $props();

	// ── Filtering ──────────────────────────────────────────────────────────

	function isHidden(node: TreeNode): boolean {
		return $hiddenPaths.some((p) => node.path === p || node.path.startsWith(p + "/"));
	}

	function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
		const lower = q.toLowerCase();
		return nodes
			.filter((n) => !isHidden(n))
			.flatMap((n) => {
				if (!n.children) {
					// Leaf: include if no query or name matches
					return !q || n.name.toLowerCase().includes(lower) ? [n] : [];
				}
				const children = filterTree(n.children, q);
				if (!children.length) return [];
				return [{ ...n, children }];
			});
	}

	const filteredTree = $derived(filterTree(siteTree, query));

	// ── Folder open state ──────────────────────────────────────────────────

	let openFolders: Record<string, boolean> = $state({});
	const toggle = (p: string) => { openFolders[p] = !openFolders[p]; };

	function itemStyle(depth: number): string {
		return `padding-inline-start: ${(depth - 1) * 17 + 8}px;`;
	}
</script>

{#snippet fileNode(node: TreeNode)}
	<div class="tree-item nav-file" class:is-active={currentPath === node.path}>
		<div
			class="tree-item-self nav-file-title is-clickable"
			class:is-active={currentPath === node.path}
			data-path={node.path}
			style={itemStyle(node.depth)}
		>
			<a href={node.path} class="tree-item-inner nav-file-title-content">
				{node.name}
			</a>
		</div>
	</div>
{/snippet}

{#snippet folderNode(node: TreeNode)}
	<div class="tree-item nav-folder" class:is-collapsed={!openFolders[node.path] && !query}>
		<div
			class="tree-item-self nav-folder-title is-clickable mod-collapsible"
			data-path={node.path}
			role="button"
			tabindex="0"
			onclick={() => toggle(node.path)}
			onkeydown={(e) => e.key === "Enter" && toggle(node.path)}
			style={itemStyle(node.depth)}
		>
			<div class="tree-item-icon collapse-icon" class:is-collapsed={!openFolders[node.path] && !query}>
				<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
					fill="none" stroke="currentColor" stroke-width="2"
					stroke-linecap="round" stroke-linejoin="round" class="svg-icon right-triangle">
					<path d="M3 8L12 17L21 8" />
				</svg>
			</div>
			<div class="tree-item-inner nav-folder-title-content">{node.name}</div>
		</div>
		{#if openFolders[node.path] || query}
			<div class="tree-item-children nav-folder-children">
				{#each node.children ?? [] as child}
					{#if child.children}{@render folderNode(child)}{:else}{@render fileNode(child)}{/if}
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div>
	{#each filteredTree as node}
		{#if node.children}{@render folderNode(node)}{:else}{@render fileNode(node)}{/if}
	{/each}
</div>