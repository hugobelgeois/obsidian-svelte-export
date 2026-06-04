<script lang="ts">
	import { tocHeadings } from "$lib/stores";
	import { onMount } from "svelte";

	let active = $state("");

	function scrollTo(id: string) {
		document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
	}

	onMount(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						active = e.target.id;
						break;
					}
				}
			},
			{ rootMargin: "0px 0px -70% 0px", threshold: 0 },
		);
		const unsub = tocHeadings.subscribe((headings) => {
			observer.disconnect();
			headings.forEach((h) => {
				const el = document.getElementById(h.id);
				if (el) observer.observe(el);
			});
		});
		return () => {
			observer.disconnect();
			unsub();
		};
	});
</script>

{#if $tocHeadings.length > 0}
	<div>
		{#each $tocHeadings as h}
			<div class="tree-item">
				<div
					class="tree-item-self is-clickable"
					class:is-active={active === h.id}
					style="padding-inline-start: {8 + (h.level - 1) * 16}px;"
					role="link"
					tabindex="0"
					onclick={() => scrollTo(h.id)}
					onkeydown={(e) => e.key === "Enter" && scrollTo(h.id)}
				>
					<div class="tree-item-inner">{h.text}</div>
				</div>
			</div>
		{/each}
	</div>
{/if}
