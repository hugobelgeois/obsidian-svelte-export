<script lang="ts">
	import Icon from "$lib/Icon.svelte";

	/** The "×" icon of every close button — sized/classed like Icon. */
	const { size, class: cls }: { size?: number; class?: string } = $props();
</script>

<Icon {size} class={cls}>
	<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
</Icon>
