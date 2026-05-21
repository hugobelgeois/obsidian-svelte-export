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

<aside class="sidebar right" class:collapsed>
	<div class="sidebar-toolbar">
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
				{#if collapsed}<path d="M15 18l-6-6 6-6" />
				{:else}<path d="M9 18l6-6-6-6" />
				{/if}
			</svg>
		</button>
		<button
			class="icon-btn"
			onclick={toggleTheme}
			title="Toggle light/dark mode"
		>
			{#if theme === "dark"}
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<circle cx="12" cy="12" r="5" />
					<path
						d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
					/>
				</svg>
			{:else}
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
				</svg>
			{/if}
		</button>
	</div>
	<div class="sidebar-body">
		<Graph />
		<Toc />
	</div>
</aside>

<div class="workspace-tabs mod-active mod-top mod-top-right-space">
	<div class="workspace-tab-container">
		<div class="workspace-leaf mod-active" style="">
			<hr class="workspace-leaf-resize-handle" />
			<div class="workspace-leaf-content" data-type="outline">
				<Graph />
				<div
					class="view-content node-insert-event"
					style="position: relative;"
				>
					<div style="">
						<div
							style="width: 238px; height: 0.1px; margin-bottom: 0px;"
						></div>
						<Toc />
						<div class="tree-item">
							<div
								class="tree-item-self is-clickable"
								draggable="true"
								style="margin-inline-start: 0px !important; padding-inline-start: 8px !important;"
							>
								<div class="tree-item-inner">Fixées</div>
							</div>
							<div
								class="tree-item-children"
								style="min-height: 0px;"
							></div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
