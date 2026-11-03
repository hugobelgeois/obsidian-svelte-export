<script lang="ts">
	import { afterNavigate } from "$app/navigation";
	import { onMount } from "svelte";

	// Images of rendered notes (pages and link previews). The note HTML is
	// injected with {@html}, so clicks are caught by delegation on the
	// document rather than handlers on each <img>. An image inside a link
	// keeps its link behaviour.
	const ZOOMABLE_IMG = ".markdown-rendered img";

	let src = $state<string | null>(null);
	let alt = $state("");

	function onClick(e: MouseEvent) {
		if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
		const img = (e.target as HTMLElement).closest<HTMLImageElement>(ZOOMABLE_IMG);
		if (!img || img.closest("a")) return;
		e.preventDefault();
		src = img.currentSrc || img.src;
		alt = img.alt;
	}

	function onKeyDown(e: KeyboardEvent) {
		if (src && e.key === "Escape") src = null;
	}

	afterNavigate(() => {
		src = null;
	});

	onMount(() => {
		document.addEventListener("click", onClick);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("click", onClick);
			window.removeEventListener("keydown", onKeyDown);
		};
	});
</script>

{#if src}
	<!-- Click anywhere (image included) or Escape closes it. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="image-lightbox"
		role="dialog"
		aria-modal="true"
		aria-label={alt || "Image"}
		tabindex="-1"
		onclick={() => (src = null)}
	>
		<img {src} {alt} />
	</div>
{/if}

<style>
	.image-lightbox {
		position: fixed;
		inset: 0;
		/* Above the link preview panel (9999), which can contain images too. */
		z-index: 10000;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: rgba(0, 0, 0, 0.8);
		cursor: zoom-out;
		animation: image-lightbox-fade-in 0.12s ease;
	}

	.image-lightbox img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		border-radius: 4px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.48);
	}

	@keyframes image-lightbox-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
</style>
