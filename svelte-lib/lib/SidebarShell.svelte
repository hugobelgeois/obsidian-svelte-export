<script lang="ts">
	import Icon from "$lib/Icon.svelte";
	import type { Snippet } from "svelte";

	/**
	 * Shared chrome for both docked sidebars: the collapsible
	 * `.workspace-split.mod-sidedock` box, its width/collapse mechanics,
	 * and the `.nav-header` row with the collapse toggle. LeftSidebar and
	 * RightSidebar only differ in what they put in that header (search
	 * box, theme toggle, …) and in their main content.
	 */
	interface Props {
		side: "left" | "right";
		collapsed: boolean;
		toggleCollapsed: () => void;
		/** Rendered in the header, before the collapse toggle (e.g. search). */
		headerBefore?: Snippet;
		/** Rendered in the header, after the collapse toggle (e.g. theme). */
		headerAfter?: Snippet;
		children: Snippet;
	}
	const {
		side,
		collapsed,
		toggleCollapsed,
		headerBefore,
		headerAfter,
		children,
	}: Props = $props();

	/** Must match the slide-out animation's duration in layout.css. */
	const CLOSE_ANIMATION_MS = 200;

	// On mobile an open sidebar is a fixed overlay, but a collapsed one is
	// back in the flex row (at width 0). Switching straight to collapsed
	// would drop it out of the overlay in the same frame, so it couldn't
	// animate away. Instead it stays an open overlay for CLOSE_ANIMATION_MS
	// with `.is-closing` (which slides it off-screen), then collapses for
	// real. Desktop has no slide-out (its width transition handles that).
	let closing = $state(false);
	let wasOpen = false;
	$effect(() => {
		if (!collapsed) {
			wasOpen = true;
			closing = false;
			return;
		}
		if (!wasOpen) return;
		wasOpen = false;
		if (window.innerWidth > 768) return;
		closing = true;
		const timer = setTimeout(() => (closing = false), CLOSE_ANIMATION_MS);
		return () => clearTimeout(timer);
	});

	let shown = $derived(!collapsed || closing);
</script>

<div
	class="workspace-split mod-horizontal mod-sidedock mod-{side}-split"
	class:is-collapsed={!shown}
	class:is-closing={closing}
	style="min-width:{shown ? '200px' : '0'};width:{shown ? '200px' : '0'};"
>
	{#if shown}
		<div class="nav-header">
			<div class="nav-buttons-container">
				{@render headerBefore?.()}
				<button
					class="clickable-icon nav-action-button"
					aria-label="Collapse sidebar"
					onclick={toggleCollapsed}
				>
					<Icon size={16}>
						{#if side === "left"}
							<path d="M15 18l-6-6 6-6" />
						{:else}
							<path d="M9 18l6-6-6-6" />
						{/if}
					</Icon>
				</button>
				{@render headerAfter?.()}
			</div>
		</div>
		{@render children()}
	{/if}
</div>
