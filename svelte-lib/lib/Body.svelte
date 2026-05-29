<script lang="ts">
	import type { Snippet } from 'svelte';
	const { children }: { children: Snippet } = $props();
</script>

<div class="workspace-split mod-vertical mod-root">
	<div class="workspace-tabs mod-top">
		<div class="workspace-tab-container">
			<div class="workspace-leaf">
				<div class="workspace-leaf-content" data-type="markdown">
					<div class="view-content">
						<div class="markdown-preview-view markdown-rendered">
							<div class="markdown-preview-sizer">
								{@render children()}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>