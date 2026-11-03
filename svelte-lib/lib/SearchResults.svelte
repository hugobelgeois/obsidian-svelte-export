<script lang="ts">
	import { base } from "$app/paths";
	import {
		prepare,
		search,
		type PreparedEntry,
		type SearchEntry,
	} from "$lib/searchText";

	/** Full-text results for the sidebar's search box, under the file tree
	 * (which only matches note names). The index (static/search.json,
	 * written at export) is fetched the first time someone searches. */
	const { query }: { query: string } = $props();

	const MIN_QUERY_LENGTH = 2;

	let index: PreparedEntry[] | null = $state(null);
	let failed = $state(false);
	let loading: Promise<void> | null = null;

	function loadIndex() {
		loading ??= fetch(`${base}/search.json`)
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json() as Promise<SearchEntry[]>;
			})
			.then((entries) => {
				index = prepare(entries);
			})
			.catch(() => {
				failed = true;
			});
	}

	const active = $derived(query.trim().length >= MIN_QUERY_LENGTH);
	$effect(() => {
		if (active) loadIndex();
	});
	const hits = $derived(active && index ? search(index, query) : []);
</script>

{#if active}
	<div class="search-results">
		<div class="search-results-title">In note contents</div>
		{#if failed}
			<div class="search-results-empty">Search unavailable</div>
		{:else if !index}
			<div class="search-results-empty">Loading…</div>
		{:else if !hits.length}
			<div class="search-results-empty">No results</div>
		{:else}
			{#each hits as hit (hit.route)}
				<a class="search-result" href="{base}{hit.route}/">
					<div class="search-result-title">{hit.title}</div>
					{#if hit.snippet[0] || hit.snippet[1] || hit.snippet[2]}
						<div class="search-result-snippet">
							{hit.snippet[0]}<mark>{hit.snippet[1]}</mark>{hit.snippet[2]}
						</div>
					{/if}
				</a>
			{/each}
		{/if}
	</div>
{/if}

<style>
	.search-results {
		border-top: 1px solid var(--background-modifier-border);
		margin-top: 6px;
		padding: 6px 4px 8px;
	}

	.search-results-title {
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		padding: 2px 8px 4px;
	}

	.search-results-empty {
		color: var(--text-faint);
		font-size: 0.85rem;
		padding: 2px 8px;
	}

	.search-result {
		display: block;
		padding: 4px 8px;
		border-radius: 4px;
		color: var(--text-normal);
	}

	.search-result:hover {
		background: var(--background-modifier-hover);
	}

	.search-result-title {
		font-size: 0.88rem;
		font-weight: 500;
	}

	.search-result-snippet {
		font-size: 0.78rem;
		color: var(--text-muted);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.search-result-snippet mark {
		background: var(--text-highlight-bg, rgba(255, 208, 0, 0.4));
		color: inherit;
		border-radius: 2px;
	}
</style>
