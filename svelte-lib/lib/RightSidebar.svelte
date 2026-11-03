<script lang="ts">
	import Graph from "$lib/Graph.svelte";
	import ThemeIcon from "$lib/ThemeIcon.svelte";
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
		<button
			class="clickable-icon nav-action-button"
			aria-label="Toggle light/dark mode"
			onclick={toggleTheme}
		>
			<ThemeIcon {theme} />
		</button>
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
