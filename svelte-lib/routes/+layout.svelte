<script lang="ts">
	import Body from "$lib/Body.svelte";
	import LeftSidebar from "$lib/LeftSidebar.svelte";
	import RightSidebar from "$lib/RightSidebar.svelte";
	import type { Snippet } from "svelte";
	import { onMount } from "svelte";
	import "../app.css";

	const { children }: { children: Snippet } = $props();

	let theme: "dark" | "light" = $state("dark");

	function applyTheme(t: "dark" | "light") {
		document.body.classList.remove("theme-dark", "theme-light");
		document.body.classList.add(`theme-${t}`);
	}

	function toggleTheme() {
		theme = theme === "dark" ? "light" : "dark";
		applyTheme(theme);
	}

	onMount(() => {
		document.body.classList.add(
			"mod-windows",
			"is-maximized",
			"obsidian-app",
			"styled-scrollbars",
			"show-inline-title",
			"show-view-header",
			"is-focused",
		);
		applyTheme(theme);
	});
</script>

<div class="app-container">
	<div class="horizontal-main-container">
		<div class="workspace is-left-sidedock-open is-right-sidedock-open">
			<LeftSidebar />
			<Body {children} />
			<RightSidebar {theme} {toggleTheme} />
		</div>
	</div>
</div>
