<script lang="ts">
	import type { Snippet } from "svelte";
	const { children }: { children: Snippet } = $props();
</script>

<div class="workspace-split mod-vertical mod-root">
	<div
		class="workspace-tabs mod-top workspace-tab-container workspace-leaf workspace-leaf-content view-content markdown-preview-view"
		data-type="markdown"
	>
		<div class="markdown-preview-sizer">
			{@render children()}
		</div>
	</div>
</div>
