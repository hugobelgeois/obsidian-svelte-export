<script lang="ts">
	import { browser } from "$app/environment";
	import { onDestroy, onMount } from "svelte";

	let visible = $state(false);
	let pinned = $state(false);
	let x = $state(0);
	let y = $state(0);
	let dragOffsetX = 0;
	let dragOffsetY = 0;
	let isDragging = $state(false);
	let html = $state("");
	let loading = $state(false);
	let error = $state(false);

	const cache = new Map<string, string>();
	let showTimer: ReturnType<typeof setTimeout> | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let panelEl: HTMLElement;

	// ── Fetch ──────────────────────────────────────────────────────────────

	async function fetchPageHtml(
		route: string,
		fragment: string,
	): Promise<string> {
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

		// Fix relative image URLs
		content.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
			const src = img.getAttribute("src");
			if (src && src.startsWith("/")) {
				img.setAttribute("src", window.location.origin + src);
			}
		});

		let pageHtml = content.innerHTML;

		if (fragment) {
			const decoded = decodeURIComponent(fragment);
			const heading = content.querySelector(`#${CSS.escape(decoded)}`);
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

		cache.set(cacheKey, pageHtml);
		return pageHtml;
	}

	// ── Hover ──────────────────────────────────────────────────────────────

	function onMouseOver(e: MouseEvent) {
		if (pinned) return;
		const link = (e.target as HTMLElement).closest<HTMLElement>(
			"a[data-wiki-href]",
		);
		if (!link) return;

		clearTimeout(hideTimer ?? undefined);
		showTimer = setTimeout(async () => {
			const route = link.dataset.wikiHref!;
			const fragment = link.dataset.wikiFragment ?? "";
			placeAt(e.clientX + 16, e.clientY + 16);
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

	function onMouseOut(e: MouseEvent) {
		if (pinned) return;

		// Don't hide if the mouse is moving INTO the panel
		const related = e.relatedTarget as HTMLElement | null;
		if (related && panelEl?.contains(related)) return;

		// Don't hide if the mouse is still over the link
		const link = (e.target as HTMLElement).closest<HTMLElement>(
			"a[data-wiki-href]",
		);
		if (!link) return;

		clearTimeout(showTimer ?? undefined);
		hideTimer = setTimeout(() => {
			visible = false;
		}, 300);
	}

	function onPanelMouseOut(e: MouseEvent) {
		if (pinned) return;

		// Don't hide if moving to the link or staying inside the panel
		const related = e.relatedTarget as HTMLElement | null;
		if (related && panelEl?.contains(related)) return;
		if (related?.closest("a[data-wiki-href]")) return;

		hideTimer = setTimeout(() => {
			visible = false;
		}, 300);
	}

	function onPanelMouseOver() {
		if (pinned) return;
		clearTimeout(hideTimer ?? undefined);
	}

	// ── Drag ───────────────────────────────────────────────────────────────

	function onPanelMouseDown(e: MouseEvent) {
		if (!pinned) return;
		if ((e.target as HTMLElement).closest(".wiki-preview-content")) return;
		isDragging = true;
		dragOffsetX = e.clientX - x;
		dragOffsetY = e.clientY - y;
		e.preventDefault();
	}

	function onWindowMouseMove(e: MouseEvent) {
		if (!isDragging) return;
		placeAt(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
	}

	function onWindowMouseUp() {
		isDragging = false;
	}

	// ── Pin / close ────────────────────────────────────────────────────────

	function togglePin() {
		pinned = !pinned;
	}

	function closePanel() {
		pinned = false;
		visible = false;
		html = "";
	}

	// ── Position ───────────────────────────────────────────────────────────

	function placeAt(cx: number, cy: number) {
		x = cx;
		y = cy;
		requestAnimationFrame(() => {
			if (!panelEl) return;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			if (x + panelEl.offsetWidth > vw - 8)
				x = cx - panelEl.offsetWidth - 8;
			if (y + panelEl.offsetHeight > vh - 8)
				y = cy - panelEl.offsetHeight - 8;
		});
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	onMount(() => {
		document.addEventListener("mouseover", onMouseOver);
		document.addEventListener("mouseout", onMouseOut);
		window.addEventListener("mousemove", onWindowMouseMove);
		window.addEventListener("mouseup", onWindowMouseUp);
	});

	onDestroy(() => {
		if (!browser) return;
		document.removeEventListener("mouseover", onMouseOver);
		document.removeEventListener("mouseout", onMouseOut);
		window.removeEventListener("mousemove", onWindowMouseMove);
		window.removeEventListener("mouseup", onWindowMouseUp);
		clearTimeout(showTimer ?? undefined);
		clearTimeout(hideTimer ?? undefined);
	});
</script>

{#if visible}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="wiki-preview-panel"
		class:is-pinned={pinned}
		class:is-dragging={isDragging}
		style="left:{x}px; top:{y}px;"
		bind:this={panelEl}
		onmouseover={onPanelMouseOver}
		onmouseout={onPanelMouseOut}
		onmousedown={onPanelMouseDown}
	>
		<div class="wiki-preview-toolbar">
			<button
				class="wiki-preview-btn"
				class:is-active={pinned}
				title={pinned ? "Unpin" : "Pin panel"}
				onclick={togglePin}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill={pinned ? "currentColor" : "none"}
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<line x1="12" y1="17" x2="12" y2="22" /><path
						d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"
					/>
				</svg>
			</button>
			<button class="wiki-preview-btn" title="Close" onclick={closePanel}>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<line x1="18" y1="6" x2="6" y2="18" /><line
						x1="6"
						y1="6"
						x2="18"
						y2="18"
					/>
				</svg>
			</button>
		</div>

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
		width: 380px;
		max-height: 420px;
		display: flex;
		flex-direction: column;
		border-radius: 8px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-primary);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.32);
		overflow: hidden;
		pointer-events: auto;
		animation: wiki-fade-in 0.12s ease;
	}

	.wiki-preview-panel.is-pinned {
		border-color: var(--interactive-accent);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.48);
	}

	.wiki-preview-panel.is-dragging {
		cursor: grabbing;
		user-select: none;
	}

	@keyframes wiki-fade-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.wiki-preview-toolbar {
		display: flex;
		justify-content: flex-end;
		gap: 2px;
		padding: 4px 6px 2px;
		flex-shrink: 0;
		background: var(--background-primary);
		border-bottom: 1px solid var(--background-modifier-border);
		cursor: grab;
	}

	.wiki-preview-panel.is-dragging .wiki-preview-toolbar {
		cursor: grabbing;
	}

	.wiki-preview-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: none;
		border-radius: 4px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
		transition:
			color 0.1s,
			background 0.1s;
	}

	.wiki-preview-btn:hover {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
	}

	.wiki-preview-btn.is-active {
		color: var(--interactive-accent);
	}

	.wiki-preview-content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 0.75rem 1rem;
		font-size: 0.85rem;
		line-height: 1.5;
	}

	.wiki-preview-panel:not(.is-pinned) .wiki-preview-content {
		-webkit-mask-image: linear-gradient(
			to bottom,
			black 80%,
			transparent 100%
		);
		mask-image: linear-gradient(to bottom, black 80%, transparent 100%);
	}

	.wiki-preview-content :global(h1:first-child),
	.wiki-preview-content :global(h2:first-child),
	.wiki-preview-content :global(h3:first-child) {
		margin-top: 0;
	}

	.wiki-preview-content :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 4px;
		display: block;
		margin: 0.5em auto;
	}

	.wiki-preview-status {
		color: var(--text-muted);
		font-size: 0.85rem;
		padding: 0.75rem 1rem;
	}
</style>
