<script lang="ts">
	import { page } from "$app/state";

	interface TocHeading {
		id: string;
		text: string;
		level: number;
	}

	let active = $state("");

	// Returned by each note's +page.ts load() (see pageexporter.ts) —
	// absent on pages that aren't notes (welcome screen, graph page).
	const headings: TocHeading[] = $derived(page.data.headings ?? []);

	function scrollTo(id: string) {
		document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
	}

	// Runs after the DOM updated for the new page, so its headings exist.
	$effect(() => {
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
		for (const h of headings) {
			const el = document.getElementById(h.id);
			if (el) observer.observe(el);
		}
		return () => observer.disconnect();
	});
</script>

{#if headings.length > 0}
	<div>
		{#each headings as h}
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
