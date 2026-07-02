<script lang="ts">
	import { page } from "$app/stores";
	import FileTree from "$lib/FileTree.svelte";

	let collapsed = $state(false);
	let query = $state("");

	function toggleCollapse() {
		collapsed = !collapsed;
	}
</script>

<div
	class="workspace-split mod-horizontal mod-sidedock mod-left-split"
	style="min-width:200px;width:200px;"
>
	<div
		class="workspace-tabs mod-top mod-top-left-space workspace-tab-container workspace-leaf workspace-leaf-content"
		class:is-collapsed={collapsed}
		data-type="file-explorer"
	>
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
					aria-label={collapsed
						? "Expand sidebar"
						: "Collapse sidebar"}
					onclick={toggleCollapse}
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
						{#if collapsed}
							<path d="M3 8L12 17L21 8" />
						{:else}
							<path d="m7 20 5-5 5 5" />
							<path d="m7 4 5 5 5-5" />
						{/if}
					</svg>
				</button>
			</div>
		</div>
		{#if !collapsed}
			<div class="nav-files-container node-insert-event">
				<FileTree
					{query}
					currentPath={$page.url.pathname}
				/>
			</div>
		{/if}
	</div>
</div>
