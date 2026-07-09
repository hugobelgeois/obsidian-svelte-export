<script lang="ts">
	import { page } from "$app/stores";
	import FileTree from "$lib/FileTree.svelte";
	import SidebarShell from "$lib/SidebarShell.svelte";

	interface Props {
		collapsed: boolean;
		toggleCollapsed: () => void;
	}
	const { collapsed, toggleCollapsed }: Props = $props();

	let query = $state("");

	// $page.url.pathname is URL-encoded by the browser (spaces become
	// "%20", etc.) while route/node paths use the literal folder names on
	// disk — decode here so FileTree's active-item comparison actually
	// matches for paths containing spaces or special characters.
	let currentPath = $derived.by(() => {
		try {
			return decodeURIComponent($page.url.pathname);
		} catch {
			return $page.url.pathname;
		}
	});
</script>

<SidebarShell side="left" {collapsed} {toggleCollapsed}>
	{#snippet headerBefore()}
		<div class="search-input-container">
			<input
				type="search"
				placeholder="Search…"
				bind:value={query}
				class="search-input"
			/>
		</div>
	{/snippet}

	<div
		class="workspace-tabs mod-top mod-top-left-space workspace-tab-container workspace-leaf workspace-leaf-content"
		data-type="file-explorer"
	>
		<div class="nav-files-container node-insert-event">
			<FileTree {query} {currentPath} />
		</div>
	</div>
</SidebarShell>
