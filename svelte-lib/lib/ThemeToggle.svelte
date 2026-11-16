<script lang="ts">
	import ThemeIcon from "$lib/ThemeIcon.svelte";

	/** The light/dark mode toggle — in the right sidebar's header, or
	 * floating on the graph page (which has no right sidebar). */
	const {
		theme,
		toggleTheme,
		class: cls,
	}: {
		theme: "dark" | "light";
		toggleTheme: () => void;
		class: string;
	} = $props();
</script>

<button
	class={cls}
	aria-label="Toggle light/dark mode"
	title="Toggle light/dark mode"
	onclick={toggleTheme}
>
	<ThemeIcon {theme} />
</button>
