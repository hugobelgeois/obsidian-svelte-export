<script lang="ts">
	import { browser } from "$app/environment";
	import { onMount } from "svelte";

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
			const url = route.endsWith("/") ? route : route + "/";
			const res = await fetch(url, { headers: { Accept: "text/html" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const text = await res.text();

			const parser = new DOMParser();
			const doc = parser.parseFromString(text, "text/html");

			const content = doc.querySelector(".markdown-rendered");
			if (!content) throw new Error("No .markdown-rendered found");

			// Fix image URLs to absolute so they load correctly
			content.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
				const src = img.getAttribute("src");
				if (src && src.startsWith("/")) {
					img.setAttribute("src", window.location.origin + src);
				}
			});

			let pageHtml = content.innerHTML;

			if (fragment) {
				const decoded = decodeURIComponent(fragment);
				const heading = content.querySelector(
					`#${CSS.escape(decoded)}`,
				);
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
		<div class="wiki-embed-status">Loading…</div>
	{:else if error}
		<div class="wiki-embed-status">Embed unavailable</div>
	{:else}
		<div class="wiki-embed-content markdown-rendered" inert>
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

	.wiki-embed-content :global(h1:first-child),
	.wiki-embed-content :global(h2:first-child),
	.wiki-embed-content :global(h3:first-child) {
		margin-top: 0;
	}

	.wiki-embed-content :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 4px;
		display: block;
		margin: 0.5em auto;
	}

	.wiki-embed-status {
		color: var(--text-muted);
		font-size: 0.85rem;
		font-style: italic;
	}
</style>
