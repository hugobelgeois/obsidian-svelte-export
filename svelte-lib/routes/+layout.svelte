<script lang="ts">
	import Body from "$lib/Body.svelte";
	import LeftSidebar from "$lib/LeftSidebar.svelte";
	import RightSidebar from "$lib/RightSidebar.svelte";
	import type { Snippet } from "svelte";
	import { onMount } from "svelte";
	import { page } from "$app/stores";
	import "../app.css";
	import "../markdown.css";
	import "../layout.css";

	const { children }: { children: Snippet } = $props();

	// The graph page's own content IS the graph — the right sidebar's mini
	// preview of the same graph would be redundant, so it's not just
	// collapsed there but not rendered at all.
	let onGraphPage = $derived(!!$page.data.isGraphPage);

	let theme: "dark" | "light" = $state("dark");

	// Collapse state lives here (not inside each sidebar) so a swipe
	// gesture on the central workspace can open either one.
	let leftCollapsed = $state(false);
	let rightCollapsed = $state(false);

	function applyTheme(t: "dark" | "light") {
		document.body.classList.remove("theme-dark", "theme-light");
		document.body.classList.add(`theme-${t}`);
	}

	function toggleTheme() {
		theme = theme === "dark" ? "light" : "dark";
		applyTheme(theme);
	}

	// On mobile both sidebars are fixed-position overlays that each cover
	// most of the screen (see the mobile block in layout.css), so having
	// both open at once just stacks one on top of the other. Opening one
	// there closes the other. On desktop they dock side by side with room
	// for both, so this only kicks in below the mobile breakpoint.
	function openLeft() {
		leftCollapsed = false;
		if (window.innerWidth <= 768) rightCollapsed = true;
	}

	function openRight() {
		if (onGraphPage) return; // not rendered on this route — nothing to open
		rightCollapsed = false;
		if (window.innerWidth <= 768) leftCollapsed = true;
	}

	// ── Swipe to open ────────────────────────────────────────────────────────
	// Swipe right → open the left sidebar. Swipe left → open the right
	// sidebar. Mostly-horizontal, decent-length swipes only, so scrolling
	// the content vertically doesn't accidentally trigger a sidebar.
	const SWIPE_THRESHOLD = 60;
	let touchStartX = 0;
	let touchStartY = 0;
	let touchTracking = false;

	function handleTouchStart(e: TouchEvent) {
		// The graph view drags/pans with touch on its own <canvas> (see
		// Graph.svelte) — don't let that gesture also register as a
		// sidebar swipe underneath it.
		touchTracking = !(e.target as HTMLElement).closest("canvas");
		touchStartX = e.touches[0].clientX;
		touchStartY = e.touches[0].clientY;
	}

	function handleTouchEnd(e: TouchEvent) {
		if (!touchTracking) return;
		const dx = e.changedTouches[0].clientX - touchStartX;
		const dy = e.changedTouches[0].clientY - touchStartY;
		if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
		if (dx > 0) {
			openLeft();
		} else {
			openRight();
		}
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

		if (window.innerWidth <= 768) {
			leftCollapsed = true;
			rightCollapsed = true;
		}
	});
</script>

<div class="app-container">
	<div class="horizontal-main-container">
		<div
			class="workspace is-left-sidedock-open is-right-sidedock-open"
			ontouchstart={handleTouchStart}
			ontouchend={handleTouchEnd}
		>
			<LeftSidebar
				collapsed={leftCollapsed}
				toggleCollapsed={() => (leftCollapsed = !leftCollapsed)}
			/>
			<Body {children} />
			{#if !onGraphPage}
				<RightSidebar
					{theme}
					{toggleTheme}
					collapsed={rightCollapsed}
					toggleCollapsed={() => (rightCollapsed = !rightCollapsed)}
				/>
			{/if}
		</div>
	</div>

	<!-- Rendered outside the sidedock boxes on purpose — see the comment on
	     .sidebar-reveal-btn in layout.css for why. -->
	{#snippet revealButton(sideClass: "left" | "right", label: string, onclick: () => void, d: string)}
		<button
			class="sidebar-reveal-btn {sideClass}"
			aria-label={label}
			title={label}
			{onclick}
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
				<path {d} />
			</svg>
		</button>
	{/snippet}

	{#if leftCollapsed}
		{@render revealButton("left", "Expand left sidebar", openLeft, "M3 8L12 17L21 8")}
	{/if}
	{#if rightCollapsed && !onGraphPage}
		{@render revealButton("right", "Expand right sidebar", openRight, "M15 18l-6-6 6-6")}
	{/if}
</div>
