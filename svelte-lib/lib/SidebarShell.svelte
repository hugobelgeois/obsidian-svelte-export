<script lang="ts">
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
</script>

<div
	class="workspace-split mod-horizontal mod-sidedock mod-{side}-split"
	class:is-collapsed={collapsed}
	style="min-width:{collapsed ? '0' : '200px'};width:{collapsed
		? '0'
		: '200px'};"
>
	{#if !collapsed}
		<div class="nav-header">
			<div class="nav-buttons-container">
				{@render headerBefore?.()}
				<button
					class="clickable-icon nav-action-button"
					aria-label="Collapse sidebar"
					onclick={toggleCollapsed}
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
						{#if side === "left"}
							<path d="M15 18l-6-6 6-6" />
						{:else}
							<path d="M9 18l6-6-6-6" />
						{/if}
					</svg>
				</button>
				{@render headerAfter?.()}
			</div>
		</div>
		{@render children()}
	{/if}
</div>
