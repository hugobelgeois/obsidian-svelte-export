<script lang="ts">
	import type { Snippet } from "svelte";
	import { afterNavigate } from "$app/navigation";
	import { page } from "$app/stores";
	const { children }: { children: Snippet } = $props();

	let contentEl: HTMLElement;

	// The scrollable area is this inner div (overflow-y:auto), not the
	// window — SvelteKit's built-in scroll reset only targets window
	// scroll, so navigating to a new page never scrolled this div back
	// to the top on its own.
	afterNavigate(() => {
		contentEl?.scrollTo(0, 0);
	});
</script>

<div class="workspace-split mod-vertical mod-root">
	<div
		class="workspace-tabs mod-top workspace-tab-container workspace-leaf workspace-leaf-content view-content markdown-preview-view"
		data-type="markdown"
		bind:this={contentEl}
	>
		<div
			class="markdown-preview-sizer"
			class:full-bleed={$page.data.fullBleed}
			class:full-height={$page.data.fullHeight}
		>
			{@render children()}
		</div>
	</div>
</div>