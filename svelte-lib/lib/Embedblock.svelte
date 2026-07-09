<script lang="ts">
	import { browser } from "$app/environment";
	import { onMount } from "svelte";
	import { fetchWikiHtml } from "$lib/wikiFetch";

	interface Props {
		route: string;
		fragment: string;
	}

	const { route, fragment }: Props = $props();

	let html = $state("");
	let loading = $state(true);
	let error = $state(false);

	onMount(async () => {
		if (!browser) return;
		try {
			html = await fetchWikiHtml(route, fragment);
		} catch {
			error = true;
		} finally {
			loading = false;
		}
	});
</script>

<div class="wiki-embed-block">
	{#if loading}
		<div class="wiki-embed-status">Loading…</div>
	{:else if error}
		<div class="wiki-embed-status">Embed unavailable</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="wiki-embed-content markdown-rendered"
			onclick={(e) => e.preventDefault()}
			onkeydown={(e) => e.preventDefault()}
		>
			{@html html}
		</div>
	{/if}
</div>

<style>
	.wiki-embed-block {
		border-left: 3px solid var(--interactive-accent);
		background: var(--background-secondary);
		border-radius: 0 6px 6px 0;
		padding: 0.75rem 1rem;
		margin: 1rem 0;
	}

	.wiki-embed-content {
		font-size: 0.9rem;
		line-height: 1.6;
		pointer-events: none;
		user-select: none;
	}

	/* First-heading/image treatment for .wiki-embed-content is shared
	   with .wiki-preview-content in markdown.css. */

	.wiki-embed-status {
		color: var(--text-muted);
		font-size: 0.85rem;
		font-style: italic;
	}
</style>
