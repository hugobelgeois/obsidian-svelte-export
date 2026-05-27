<script lang="ts">
	import { tocHeadings } from "$lib/stores";
	import { onMount } from "svelte";

	let active = $state("");

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
					style="margin-inline-start: 0px !important; padding-inline-start: {8 +
						(h.level - 1) * 16}px !important;"
					role="link"
					tabindex="0"
					onclick={() =>
						document
							.getElementById(h.id)
							?.scrollIntoView({ behavior: "smooth" })}
					onkeydown={(e) =>
						e.key === "Enter" &&
						document
							.getElementById(h.id)
							?.scrollIntoView({ behavior: "smooth" })}
				>
					<div class="tree-item-inner">{h.text}</div>
				</div>
				<div class="tree-item-children" style="min-height: 0px;"></div>
			</div>
		{/each}
	</div>
{/if}
