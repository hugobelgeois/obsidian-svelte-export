<script lang="ts">
	import Body from "$lib/Body.svelte";
	import LeftSidebar from "$lib/LeftSidebar.svelte";
	import ImageLightbox from "$lib/ImageLightbox.svelte";
	import LinkPreview from "$lib/LinkPreview.svelte";
	import Icon from "$lib/Icon.svelte";
	import RightSidebar from "$lib/RightSidebar.svelte";
	import ThemeIcon from "$lib/ThemeIcon.svelte";
	import { DEFAULT_COLOR_MODE, STYLE_SETTINGS_CLASSES } from "$lib/exportData";
	import type { Snippet } from "svelte";
	import { onMount, tick } from "svelte";
	import { afterNavigate } from "$app/navigation";
	import { page } from "$app/state";
	import "../markdown-fallback.css";
	import "../app.css";
	import "../markdown.css";
	import "../layout.css";

	const { children }: { children: Snippet } = $props();

	// User-supplied .js/.ts files (see the plugin's "Custom scripts"
	// setting), copied in at export time by writeCustomScripts() in
	// siteFiles.ts. Lazy (not `eager: true`) so nothing runs during SSR/
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
	let onGraphPage = $derived(!!page.data.isGraphPage);

	/** Where the visitor's own color mode choice is saved. Must match
	 * COLOR_MODE_KEY in the plugin's src/siteFiles.ts, whose script in
	 * app.html applies it before the page is first painted. */
	const COLOR_MODE_KEY = "svelte-exporter-color-mode";

	let theme: "dark" | "light" = $state(DEFAULT_COLOR_MODE);

	// Collapse state lives here (not inside each sidebar) so the floating
	// reveal buttons below (and the mobile "open one, close the other"
	// behavior in openLeft/openRight) can control either one.
	//
	// Defaults to collapsed (not open) on purpose: every page is prerendered
	// server-side (see `export const prerender = true` in +page.ts), where
	// there's no `window` to check screen width — the very first HTML a
	// mobile visitor's browser paints, before any JS has loaded/hydrated,
	// is whatever this default is. Defaulting to open (the old behavior)
	// meant every mobile page load started with both 200px-wide sidebars
	// laid out — desktop's shape, not remotely fitting a phone screen, with
	// nothing to scroll to reach the squeezed content between them — until
	// onMount corrected it, however long that took. Collapsed is the safe
	// default for a screen of unknown size; onMount below now only
	// *expands* them back open once it can confirm the screen is actually
	// wide enough for that.
	let leftCollapsed = $state(true);
	let rightCollapsed = $state(true);

	function applyTheme(t: "dark" | "light") {
		document.body.classList.remove("theme-dark", "theme-light");
		document.body.classList.add(`theme-${t}`);
	}

	function toggleTheme() {
		theme = theme === "dark" ? "light" : "dark";
		applyTheme(theme);
		try {
			localStorage.setItem(COLOR_MODE_KEY, theme);
		} catch {
			// storage unavailable (private mode…) — the choice lasts this visit
		}
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
		// app.html's script already applied the saved mode, if any.
		if (document.body.classList.contains("theme-light")) theme = "light";
		else if (document.body.classList.contains("theme-dark")) theme = "dark";
		applyTheme(theme);

		// Both start collapsed (see the $state default above) — open them
		// back up here if the screen actually has room for them.
		if (window.innerWidth > 768) {
			leftCollapsed = false;
			rightCollapsed = false;
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
		<div class="workspace is-left-sidedock-open is-right-sidedock-open">
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
			<Icon size={16}>
				<path {d} />
			</Icon>
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
			<ThemeIcon {theme} />
		</button>
	{/if}

	<!-- Hover previews of every page's internal links — mounted once here,
	     so the pages fetched for them stay cached across navigations. -->
	<LinkPreview />

	<!-- Full-size view of a clicked note image. -->
	<ImageLightbox />
</div>
