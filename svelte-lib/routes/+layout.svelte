<script lang="ts">
	import Body from "$lib/Body.svelte";
	import LeftSidebar from "$lib/LeftSidebar.svelte";
	import RightSidebar from "$lib/RightSidebar.svelte";
	import { STYLE_SETTINGS_CLASSES } from "$lib/styleSettingsClasses";
	import { DEFAULT_COLOR_MODE } from "$lib/themeConfig";
	import type { Snippet } from "svelte";
	import { onMount, tick } from "svelte";
	import { afterNavigate } from "$app/navigation";
	import { page } from "$app/stores";
	import "../app.css";
	import "../markdown.css";
	import "../layout.css";

	const { children }: { children: Snippet } = $props();

	// User-supplied .js/.ts files (see the plugin's "Custom scripts"
	// setting), copied in at export time by writeCustomScripts() in
	// main.ts. Lazy (not `eager: true`) so nothing runs during SSR/
	// prerender — only after hydration in onMount below, where each
	// module's default export (if a function) is called once. A relative
	// path, not the "$lib" alias — import.meta.glob resolves patterns via
	// fast-glob against the filesystem, not through Vite's normal module
	// resolver, so it only reliably matches aliases backed by an absolute
	// resolve.alias entry; a relative path sidesteps that alias-resolution
	// step, which otherwise silently returns an empty match (no error).
	const customScripts = import.meta.glob("../lib/customScripts/*.{js,ts}");

	// The graph page's own content IS the graph — the right sidebar's mini
	// preview of the same graph would be redundant, so it's not just
	// collapsed there but not rendered at all. It's also where the
	// light/dark toggle normally lives (in the right sidebar's header), so
	// a standalone copy of that toggle is rendered here instead — see
	// themeToggleButton below.
	let onGraphPage = $derived(!!$page.data.isGraphPage);

	let theme: "dark" | "light" = $state(DEFAULT_COLOR_MODE);

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
			...STYLE_SETTINGS_CLASSES,
		);
		applyTheme(theme);

		if (window.innerWidth <= 768) {
			leftCollapsed = true;
			rightCollapsed = true;
		}
	});

	// onMount alone only fires once, when this root layout first mounts —
	// but SvelteKit keeps the layout mounted across client-side
	// navigations between pages, so a script meant to process each page's
	// content (per the "Custom scripts" setting's own description: "runs
	// once, after the page mounts") would otherwise only ever run on the
	// very first page loaded, leaving raw/unprocessed content behind on
	// every page reached via in-app navigation until a hard reload. Using
	// afterNavigate instead reruns the scripts after every navigation
	// (it also fires once on initial mount, so onMount doesn't need its
	// own copy of this loop). `tick()` waits for the new page's DOM to be
	// committed first, since the scripts query rendered content.
	afterNavigate(() => {
		tick().then(() => {
			for (const importScript of Object.values(customScripts)) {
				importScript()
					.then((mod: any) => {
						if (typeof mod?.default === "function") mod.default();
					})
					.catch((e) =>
						console.error("[custom script] failed to load", e),
					);
			}
		});
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
		{@render revealButton("left", "Expand left sidebar", openLeft, "M9 18l6-6-6-6")}
	{/if}
	{#if rightCollapsed && !onGraphPage}
		{@render revealButton("right", "Expand right sidebar", openRight, "M15 18l-6-6 6-6")}
	{/if}

	<!-- The graph page hides the right sidebar entirely (its own content IS
	     the graph), which is also where the light/dark toggle normally
	     lives — so it needs its own floating copy here, same reasoning as
	     revealButton above (a position:fixed button outside every box that
	     could clip or reposition it). -->
	{#if onGraphPage}
		<button
			class="sidebar-reveal-btn right theme-toggle-btn"
			aria-label="Toggle light/dark mode"
			title="Toggle light/dark mode"
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
					<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
				</svg>
			{/if}
		</button>
	{/if}
</div>
