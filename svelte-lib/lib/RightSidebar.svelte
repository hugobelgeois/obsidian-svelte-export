<script lang="ts">
	import Graph from "$lib/Graph.svelte";
	import Toc from "$lib/Toc.svelte";

	interface Props {
		theme: "dark" | "light";
		toggleTheme: () => void;
	}
	const { theme, toggleTheme }: Props = $props();

	let collapsed = $state(false);
</script>

<div
	class="workspace-split mod-horizontal mod-sidedock mod-right-split"
	style="min-width:200px;width:200px;"
>
	<div
		class="workspace-tabs mod-top mod-top-right-space workspace-tab-container workspace-leaf workspace-leaf-content"
		class:is-collapsed={collapsed}
		data-type="outline"
	>
		<div class="nav-header">
			<div class="nav-buttons-container">
				<button
					class="clickable-icon nav-action-button"
					aria-label={collapsed
						? "Expand sidebar"
						: "Collapse sidebar"}
					onclick={() => (collapsed = !collapsed)}
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
							<path d="M15 18l-6-6 6-6" />
						{:else}
							<path d="M9 18l6-6-6-6" />
						{/if}
					</svg>
				</button>
				<button
					class="clickable-icon nav-action-button"
					aria-label="Toggle light/dark mode"
					onclick={toggleTheme}
				>
					{#if theme === "dark"}
						<!-- Sun -->
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
							<circle cx="12" cy="12" r="5" />
							<path
								d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
							/>
						</svg>
					{:else}
						<!-- Moon -->
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
							<path
								d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
							/>
						</svg>
					{/if}
				</button>
			</div>
		</div>
		{#if !collapsed}
			<div class="view-content node-insert-event">
				<Graph />
				<Toc />
			</div>
		{/if}
	</div>
</div>
