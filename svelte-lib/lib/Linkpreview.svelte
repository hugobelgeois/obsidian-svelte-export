<script lang="ts">
	import { browser } from "$app/environment";
	import { onDestroy, onMount } from "svelte";

	let visible = $state(false);
	let x = $state(0);
	let y = $state(0);
	let html = $state("");
	let loading = $state(false);
	let error = $state(false);

	const cache = new Map<string, string>();
	let showTimer: ReturnType<typeof setTimeout> | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let panelEl: HTMLElement;

	async function fetchPageHtml(route: string, fragment: string): Promise<string> {
		if (!browser) throw new Error("SSR");
		const cacheKey = route + (fragment ? "#" + fragment : "");
		if (cache.has(cacheKey)) return cache.get(cacheKey)!;

		const url = route.endsWith("/") ? route : route + "/";
		const res = await fetch(url, { headers: { Accept: "text/html" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();

		const parser = new DOMParser();
		const doc = parser.parseFromString(text, "text/html");
		const content =
			doc.querySelector(".markdown-rendered") ??
			doc.querySelector("article");
		if (!content) throw new Error("selector not found");

		let pageHtml = content.innerHTML;

		if (fragment) {
			const decoded = decodeURIComponent(fragment);
			const heading = content.querySelector(`#${CSS.escape(decoded)}`);
			if (heading) {
				const level = parseInt(heading.tagName[1]);
				const parts: string[] = [heading.outerHTML];
				let sib = heading.nextElementSibling;
				while (sib) {
					if (sib.tagName.match(/^H[1-6]$/) && parseInt(sib.tagName[1]) <= level) break;
					parts.push(sib.outerHTML);
					sib = sib.nextElementSibling;
				}
				pageHtml = parts.join("");
			}
		}

		cache.set(cacheKey, pageHtml);
		return pageHtml;
	}

	function onLinkEnter(e: MouseEvent) {
		const link = (e.target as HTMLElement).closest<HTMLElement>("a[data-wiki-href]");
		if (!link) return;
		clearTimeout(hideTimer ?? undefined);
		showTimer = setTimeout(async () => {
			const route = link.dataset.wikiHref!;
			const fragment = link.dataset.wikiFragment ?? "";
			x = e.clientX + 16;
			y = e.clientY + 16;
			loading = true;
			error = false;
			visible = true;
			html = "";
			try {
				html = await fetchPageHtml(route, fragment);
			} catch {
				error = true;
			} finally {
				loading = false;
			}
		}, 300);
	}

	function onLinkLeave() {
		clearTimeout(showTimer ?? undefined);
		hideTimer = setTimeout(() => { visible = false; }, 150);
	}

	function onPanelEnter() { clearTimeout(hideTimer ?? undefined); }
	function onPanelLeave() { hideTimer = setTimeout(() => { visible = false; }, 150); }

	function onMouseMove(e: MouseEvent) {
		if (!visible || !panelEl) return;
		x = e.clientX + 16;
		y = e.clientY + 16;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (x + panelEl.offsetWidth  > vw - 8) x = e.clientX - panelEl.offsetWidth  - 8;
		if (y + panelEl.offsetHeight > vh - 8) y = e.clientY - panelEl.offsetHeight - 8;
	}

	onMount(() => {
		document.addEventListener("mouseover", onLinkEnter);
		document.addEventListener("mouseout",  onLinkLeave);
		document.addEventListener("mousemove", onMouseMove);
	});

	onDestroy(() => {
		if (!browser) return;
		document.removeEventListener("mouseover", onLinkEnter);
		document.removeEventListener("mouseout",  onLinkLeave);
		document.removeEventListener("mousemove", onMouseMove);
		clearTimeout(showTimer ?? undefined);
		clearTimeout(hideTimer ?? undefined);
	});
</script>

{#if visible}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="wiki-preview-panel"
		style="left:{x}px; top:{y}px;"
		bind:this={panelEl}
		onmouseenter={onPanelEnter}
		onmouseleave={onPanelLeave}
	>
		{#if loading}
			<div class="wiki-preview-status">Loading…</div>
		{:else if error}
			<div class="wiki-preview-status">Preview unavailable</div>
		{:else}
			<div class="wiki-preview-content markdown-rendered">
				{@html html}
			</div>
		{/if}
	</div>
{/if}

<style>
	.wiki-preview-panel {
		position: fixed;
		z-index: 9999;
		width: 360px;
		max-height: 320px;
		overflow: hidden;
		border-radius: 8px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-primary);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28);
		padding: 1rem 1.1rem;
		pointer-events: auto;
		animation: wiki-fade-in 0.12s ease;
	}
	@keyframes wiki-fade-in {
		from { opacity: 0; transform: translateY(4px); }
		to   { opacity: 1; transform: translateY(0); }
	}
	.wiki-preview-content {
		overflow: hidden;
		max-height: 288px;
		font-size: 0.85rem;
		line-height: 1.5;
		-webkit-mask-image: linear-gradient(to bottom, black 70%, transparent 100%);
		mask-image: linear-gradient(to bottom, black 70%, transparent 100%);
	}
	.wiki-preview-content :global(h1:first-child),
	.wiki-preview-content :global(h2:first-child),
	.wiki-preview-content :global(h3:first-child) { margin-top: 0; }
	.wiki-preview-status {
		color: var(--text-muted);
		font-size: 0.85rem;
		padding: 0.5rem 0;
	}
</style>