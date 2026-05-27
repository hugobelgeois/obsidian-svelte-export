<script lang="ts">
	import { page } from "$app/stores";
	import FileTree from "$lib/FileTree.svelte";

	let collapsed = $state(false);
	let query = $state("");
</script>

<div
	class="workspace-split mod-horizontal mod-sidedock mod-left-split"
	style="min-width: 200px; width: 200px;"
>
	<div
		class="workspace-tabs mod-top mod-top-left-space"
		class:is-collapsed={collapsed}
	>
		<div class="workspace-tab-container">
			<div class="workspace-leaf">
				<div class="workspace-leaf-content" data-type="file-explorer">
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
							<div
								class="clickable-icon nav-action-button"
								role="button"
								tabindex="0"
								aria-label={collapsed
									? "Expand sidebar"
									: "Collapse sidebar"}
								onclick={() => (collapsed = !collapsed)}
								onkeydown={(e) =>
									e.key === "Enter" &&
									(collapsed = !collapsed)}
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
								>
									{#if collapsed}
										<path d="M3 8L12 17L21 8"></path>
									{:else}
										<path d="m7 20 5-5 5 5"></path>
										<path d="m7 4 5 5 5-5"></path>
									{/if}
								</svg>
							</div>
						</div>
					</div>
					<div
						class="nav-files-container node-insert-event"
						style="position: relative;"
					>
						{#if !collapsed}
							<FileTree
								{query}
								currentPath={$page.url.pathname}
							/>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
