<script lang="ts">
	import { page } from "$app/stores";
	import FileTree from "$lib/FileTree.svelte";

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

<div
	class="workspace-split mod-horizontal mod-sidedock mod-left-split"
	class:is-collapsed={collapsed}
	style="min-width:{collapsed ? '0' : '200px'};width:{collapsed
		? '0'
		: '200px'};"
>
	{#if !collapsed}
		<div class="nav-header">
			<div class="nav-buttons-container">
				<div class="search-input-container">
					<input
						type="search"
						placeholder="Search…"
						bind:value={query}
						class="search-input"
					/>
				</div>
				<button
					class="clickable-icon nav-action-button"
					aria-label="Collapse sidebar"
					onclick={toggleCollapsed}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="svg-icon"
					>
						<path d="m7 20 5-5 5 5" />
						<path d="m7 4 5 5 5-5" />
					</svg>
				</button>
			</div>
		</div>
		<div
			class="workspace-tabs mod-top mod-top-left-space workspace-tab-container workspace-leaf workspace-leaf-content"
			data-type="file-explorer"
		>
			<div class="nav-files-container node-insert-event">
				<FileTree {query} {currentPath} />
			</div>
		</div>
	{/if}
</div>
