<script lang="ts">
	import { onMount } from "svelte";

	interface Props {
		route: string; // decoded route path, e.g. "/Folder/Note"
		fragment: string; // decoded fragment, e.g. "Section Title", or ""
	}

	const { route, fragment }: Props = $props();

	let html = $state("");
	let loading = $state(true);
	let error = $state(false);

	// ── Fetch ──────────────────────────────────────────────────────────────

	onMount(async () => {
		try {
			const dataUrl = route.replace(/\/?$/, "/") + "__data.json";
			const res = await fetch(dataUrl);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();

			let pageHtml = "";
			for (const node of json.nodes ?? []) {
				if (!node?.data) continue;
				const htmlEntry = node.data.find?.(
					(v: unknown) => typeof v === "string" && v.startsWith("<"),
				);
				if (htmlEntry) {
					pageHtml = htmlEntry;
					break;
				}
			}

			if (!pageHtml) throw new Error("No HTML in page data");

			if (fragment) {
				const tmp = document.createElement("div");
				tmp.innerHTML = pageHtml;
				const heading = tmp.querySelector(`#${CSS.escape(fragment)}`);
				if (heading) {
					const level = parseInt(heading.tagName[1]);
					const parts: string[] = [heading.outerHTML];
					let sib = heading.nextElementSibling;
					while (sib) {
						if (
							sib.tagName.match(/^H[1-6]$/) &&
							parseInt(sib.tagName[1]) <= level
						)
							break;
						parts.push(sib.outerHTML);
						sib = sib.nextElementSibling;
					}
					pageHtml = parts.join("");
				}
			}

			html = pageHtml;
		} catch {
			error = true;
		} finally {
			loading = false;
		}
	});
</script>

<div class="wiki-embed-block">
	{#if loading}
		<div class="wiki-embed-loading">Loading…</div>
	{:else if error}
		<div class="wiki-embed-error">Embed unavailable</div>
	{:else}
		<!--
			inert makes the entire subtree non-interactive:
			no clicks, no tab focus, no links — exactly what ![[]] should be.
		-->
		<div class="wiki-embed-content md-content" inert>
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
		/* Prevent any pointer interaction even without inert support */
		pointer-events: none;
		user-select: none;
	}

	/* Suppress top margin on first heading */
	.wiki-embed-content :global(h1:first-child),
	.wiki-embed-content :global(h2:first-child),
	.wiki-embed-content :global(h3:first-child) {
		margin-top: 0;
	}

	.wiki-embed-loading,
	.wiki-embed-error {
		color: var(--text-muted);
		font-size: 0.85rem;
		font-style: italic;
	}
</style>
