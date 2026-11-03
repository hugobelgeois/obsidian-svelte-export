<script lang="ts">
	import type { Snippet } from "svelte";

	/** Shared wrapper for the app's stroked 24×24 line icons — only the
	 * shapes inside (children) differ from one icon to the next. */
	interface Props {
		/** Rendered width/height; omitted = sized by CSS (.svg-icon). */
		size?: number;
		fill?: string;
		class?: string;
		children: Snippet;
	}
	const { size, fill = "none", class: cls = "svg-icon", children }: Props =
		$props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	{fill}
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={cls}
>
	{@render children()}
</svg>
