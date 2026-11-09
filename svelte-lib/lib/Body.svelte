<script lang="ts">
	import type { Snippet } from "svelte";
	import { afterNavigate } from "$app/navigation";
	import { page } from "$app/state";
	import Icon from "$lib/Icon.svelte";
	const {
		children,
		onContentClick,
	}: {
		children: Snippet;
		/** Capture-phase click anywhere in the note column; returns true if
		 * it consumed the click (it then never reaches links/buttons inside). */
		onContentClick?: () => boolean;
	} = $props();

	function handleClickCapture(e: MouseEvent) {
		if (onContentClick?.()) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	let contentEl: HTMLElement;

	// The scrollable area is this inner div (overflow-y:auto), not the
	// window — SvelteKit's built-in scroll reset only targets window
	// scroll, so navigating to a new page never scrolled this div back
	// to the top on its own.
	afterNavigate(() => {
		contentEl?.scrollTo(0, 0);
	});

	// ── Pull to refresh ──────────────────────────────────────────
	// Mobile browsers only offer their native pull-to-refresh when the
	// *document* is scrolled to the top — but here the document never
	// scrolls (body is overflow:hidden; this inner div is the scroller, to
	// keep the Obsidian-like fixed layout), so pulling down at the top of a
	// note did nothing. Re-implemented here: a downward drag that starts
	// with the note scrolled to the top shows an indicator, and releasing it
	// past PULL_THRESHOLD reloads the page. Touch listeners are passive
	// (Svelte's default for touchstart/touchmove), so scrolling is never
	// held up — at scrollTop 0 a downward drag has nothing to scroll anyway.

	/** Pull distance (after damping) that triggers the reload, in px. */
	const PULL_THRESHOLD = 70;
	/** The indicator stops following the finger past this, in px. */
	const PULL_MAX = 110;
	/** Finger travel → indicator travel, so the pull feels like it resists. */
	const PULL_DAMPING = 0.5;

	let pullStartX = 0;
	let pullStartY: number | null = null;
	let pull = $state(0);
	let refreshing = $state(false);

	function onTouchStart(e: TouchEvent) {
		pullStartY = null;
		if (refreshing || e.touches.length !== 1 || contentEl.scrollTop > 0) return;
		// Canvases (the graph) handle their own drags — pulling there pans.
		if ((e.target as Element | null)?.closest?.("canvas")) return;
		const t = e.touches[0]!;
		pullStartX = t.clientX;
		pullStartY = t.clientY;
	}

	function onTouchMove(e: TouchEvent) {
		if (pullStartY === null) return;
		const t = e.touches[0]!;
		const dy = t.clientY - pullStartY;
		const dx = Math.abs(t.clientX - pullStartX);
		// Scrolling the note down, a mostly-sideways swipe (wide table,
		// code block), or the note scrolled meanwhile: not a pull.
		if (dy <= 0 || (pull === 0 && dx > dy) || contentEl.scrollTop > 0) {
			pullStartY = null;
			pull = 0;
			return;
		}
		pull = Math.min(dy * PULL_DAMPING, PULL_MAX);
	}

	function onTouchEnd() {
		if (pullStartY !== null && pull >= PULL_THRESHOLD) {
			refreshing = true;
			pull = PULL_THRESHOLD;
			location.reload();
		} else {
			pull = 0;
		}
		pullStartY = null;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
	class="workspace-split mod-vertical mod-root"
	onclickcapture={handleClickCapture}
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
	ontouchcancel={onTouchEnd}
>
	{#if pull > 0 || refreshing}
		<div
			class="pull-refresh-indicator"
			class:ready={pull >= PULL_THRESHOLD}
			class:refreshing
			style:transform="translate(-50%, {pull - 40}px)"
			aria-hidden="true"
		>
			<span style:transform="rotate({refreshing ? 0 : pull * 3}deg)">
				<Icon size={18}>
					<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
					<path d="M21 3v5h-5" />
				</Icon>
			</span>
		</div>
	{/if}
	<div
		class="workspace-tabs mod-top workspace-tab-container workspace-leaf workspace-leaf-content view-content markdown-preview-view"
		data-type="markdown"
		bind:this={contentEl}
	>
		<div
			class="markdown-preview-sizer"
			class:full-bleed={page.data.fullBleed}
			class:full-height={page.data.fullHeight}
		>
			{@render children()}
		</div>
	</div>
</div>

<style>
	/* .mod-root is overflow:hidden, so the indicator slides in from above
	   its top edge, clipped until pulled into view. */
	.mod-root {
		position: relative;
	}

	.pull-refresh-indicator {
		position: absolute;
		top: 0;
		left: 50%;
		z-index: 20;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		box-shadow: var(--shadow-s);
		color: var(--text-muted);
		pointer-events: none;
	}

	.pull-refresh-indicator.ready {
		color: var(--interactive-accent);
	}

	.pull-refresh-indicator span {
		display: flex;
	}

	.pull-refresh-indicator.refreshing span {
		animation: pull-refresh-spin 0.8s linear infinite;
	}

	@keyframes pull-refresh-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
