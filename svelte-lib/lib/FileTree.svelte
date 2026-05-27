<script lang="ts">
	import { siteTree, type TreeNode } from "$lib/siteTree";
	import { hiddenPaths } from "$lib/stores";

	interface Props {
		query: string;
		currentPath: string;
	}
	const { query, currentPath }: Props = $props();

	// ── Hidden filtering ───────────────────────────────────────────────────

	function isHidden(node: TreeNode): boolean {
		return $hiddenPaths.some(
			(p) => node.path === p || node.path.startsWith(p + "/"),
		);
	}

	function filterHidden(nodes: TreeNode[]): TreeNode[] {
		return nodes
			.filter((n) => !isHidden(n))
			.map((n) =>
				n.children
					? { ...n, children: filterHidden(n.children) }
					: n,
			)
			// Remove folders that have no visible children left
			.filter((n) => !n.children || n.children.length > 0);
	}

	// ── Search filtering ───────────────────────────────────────────────────

	function matchesQuery(node: TreeNode, q: string): boolean {
		if (!q) return true;
		const lower = q.toLowerCase();
		if (node.name.toLowerCase().includes(lower)) return true;
		if (node.children) return node.children.some((c) => matchesQuery(c, q));
		return false;
	}

	const visibleTree = $derived(filterHidden(siteTree));

	const filteredTree = $derived(
		query ? visibleTree.filter((n) => matchesQuery(n, query)) : visibleTree,
	);

	// ── Folder open state ──────────────────────────────────────────────────

	let openFolders: Record<string, boolean> = $state({});
	const toggle = (p: string) => { openFolders[p] = !openFolders[p]; };

	// ── Indentation ────────────────────────────────────────────────────────

	function itemStyle(depth: number): string {
		const indent = (depth - 1) * 17;
		return `margin-inline-start: -${indent}px !important; padding-inline-start: ${8 + indent}px !important;`;
	}
</script>

{#snippet fileNode(node: TreeNode)}
	<div class="tree-item nav-file" class:is-active={currentPath === node.path}>
		<div
			class="tree-item-self nav-file-title tappable is-clickable"
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
	<div
		class="tree-item nav-folder"
		class:is-collapsed={!openFolders[node.path] && !query}
	>
		<div
			class="tree-item-self nav-folder-title is-clickable mod-collapsible"
			data-path={node.path}
			role="button"
			tabindex="0"
			onclick={() => toggle(node.path)}
			onkeydown={(e) => e.key === "Enter" && toggle(node.path)}
			style={itemStyle(node.depth)}
		>
			<div
				class="tree-item-icon collapse-icon"
				class:is-collapsed={!openFolders[node.path] && !query}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24" height="24" viewBox="0 0 24 24"
					fill="none" stroke="currentColor"
					stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
					class="svg-icon right-triangle"
				>
					<path d="M3 8L12 17L21 8"></path>
				</svg>
			</div>
			<div class="tree-item-inner nav-folder-title-content">
				{node.name}
			</div>
		</div>
		{#if openFolders[node.path] || query}
			<div class="tree-item-children nav-folder-children">
				{#each node.children ?? [] as child}
					{#if child.children}
						{@render folderNode(child)}
					{:else}
						{@render fileNode(child)}
					{/if}
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div>
	{#each filteredTree as node}
		{#if node.children}
			{@render folderNode(node)}
		{:else}
			{@render fileNode(node)}
		{/if}
	{/each}
</div>