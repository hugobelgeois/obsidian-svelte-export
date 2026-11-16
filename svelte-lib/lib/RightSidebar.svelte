<script lang="ts">
	import Graph from "$lib/Graph.svelte";
	import ThemeToggle from "$lib/ThemeToggle.svelte";
	import Toc from "$lib/Toc.svelte";
	import SidebarShell from "$lib/SidebarShell.svelte";

	interface Props {
		theme: "dark" | "light";
		toggleTheme: () => void;
		collapsed: boolean;
		toggleCollapsed: () => void;
	}
	const { theme, toggleTheme, collapsed, toggleCollapsed }: Props = $props();
</script>

<SidebarShell side="right" {collapsed} {toggleCollapsed}>
	{#snippet headerAfter()}
		<ThemeToggle
			class="clickable-icon nav-action-button"
			{theme}
			{toggleTheme}
		/>
	{/snippet}

	<div
		class="workspace-tabs mod-top mod-top-right-space workspace-tab-container workspace-leaf workspace-leaf-content"
		data-type="outline"
	>
		<div class="view-content node-insert-event">
			<Graph />
			<Toc />
		</div>
	</div>
</SidebarShell>
