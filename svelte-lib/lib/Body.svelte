<script lang="ts">
	import type { Snippet } from 'svelte';
	const { children }: { children: Snippet } = $props();
</script>

<div class="workspace-split mod-vertical mod-root">
    <div class="workspace-tabs mod-top">
        <div class="workspace-tab-container">
            <div class="workspace-leaf">
                <div class="workspace-leaf-content" data-type="empty">
                    <div class="view-content">
                        <div class="markdown-source-view cm-s-obsidian mod-cm6 node-insert-event is-live-preview is-folding show-properties" style="">
                            <div class="cm-editor ͼ1 ͼ2 ">
                                <div tabindex="-1" class="cm-scroller">
                                    <div class="cm-sizer">
                                        {@render children()}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>

<!-- # Obsidian body structure (inside {@render children()} )
<div class="inline-title" contenteditable="true" spellcheck="true" autocapitalize="on" tabindex="-1" enterkeyhint="done">
	# Markdown Title
</div>
<div class="cm-contentContainer">
	<div spellcheck="true" autocorrect="on" autocapitalize="on" writingsuggestions="false" translate="no" contenteditable="true" style="tab-size: 4; padding-bottom: 417px;" class="cm-content cm-lineWrapping" role="textbox" aria-multiline="true" data-language="hypermd"><div class="cm-active HyperMD-header HyperMD-header-2 cm-line" dir="ltr">
		# Markdown body
	</div>
</div>
-->