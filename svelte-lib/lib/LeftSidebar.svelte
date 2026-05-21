<script lang="ts">
	import { page } from "$app/stores";
	import FileTree from "$lib/FileTree.svelte";

	let collapsed = $state(false);
	let query = $state("");
</script>

<aside class="sidebar left" class:collapsed>
	<div class="sidebar-toolbar">
		<div class="search-wrap">
			<span class="search-icon">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<circle cx="11" cy="11" r="8" /><path
						d="m21 21-4.35-4.35"
					/>
				</svg>
			</span>
			<input type="search" placeholder="Search…" bind:value={query} />
		</div>
		<button
			class="icon-btn collapse-btn"
			onclick={() => (collapsed = !collapsed)}
			title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				{#if collapsed}<path d="M9 18l6-6-6-6" />
				{:else}<path d="M15 18l-6-6 6-6" />
				{/if}
			</svg>
		</button>
	</div>
	<div class="sidebar-body">
		<FileTree {query} currentPath={$page.url.pathname} />
	</div>
</aside>

<div class="workspace-tabs mod-top mod-top-left-space" style="">
	<div class="workspace-tab-container">
		<div class="workspace-leaf">
			<hr class="workspace-leaf-resize-handle" />
			<div class="workspace-leaf-content" data-type="file-explorer">
				<div class="nav-header">
					<div class="nav-buttons-container">
						<div
							class="clickable-icon nav-action-button"
							aria-label="Tout réduire"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								class="svg-icon lucide-chevrons-down-up"
								><path d="m7 20 5-5 5 5"></path><path
									d="m7 4 5 5 5-5"
								></path></svg
							>
						</div>
					</div>
				</div>
				<div
					class="nav-files-container node-insert-event"
					style="position: relative;"
				>
					<div style="">
						<div
							style="width: 294px; height: 0.1px; margin-bottom: 0px;"
						></div>
						<FileTree {query} currentPath={$page.url.pathname} />
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
