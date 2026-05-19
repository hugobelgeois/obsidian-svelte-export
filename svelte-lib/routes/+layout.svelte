<script lang="ts">
  import type { Snippet } from 'svelte';
  import LeftSidebar from '$lib/LeftSidebar.svelte';
  import RightSidebar from '$lib/RightSidebar.svelte';
  import '../app.css';

  const { children }: { children: Snippet } = $props();

  let theme: 'dark' | 'light' = $state('dark');

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }
</script>

<div class="app-shell">
  <LeftSidebar />
  <main class="content-area">
    {@render children()}
  </main>
  <RightSidebar {theme} {toggleTheme} />
</div>
