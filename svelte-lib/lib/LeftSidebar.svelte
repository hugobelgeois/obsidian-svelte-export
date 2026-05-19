<script lang="ts">
  import { page } from '$app/stores';
  import FileTree from '$lib/FileTree.svelte';

  let collapsed = $state(false);
  let query = $state('');
</script>

<aside class="sidebar left" class:collapsed>
  <div class="sidebar-toolbar">
    <div class="search-wrap">
      <span class="search-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
      </span>
      <input type="search" placeholder="Search…" bind:value={query} />
    </div>
    <button class="icon-btn collapse-btn"
      onclick={() => collapsed = !collapsed}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        {#if collapsed}<path d="M9 18l6-6-6-6"/>
        {:else}<path d="M15 18l-6-6 6-6"/>
        {/if}
      </svg>
    </button>
  </div>
  <div class="sidebar-body">
    <FileTree {query} currentPath={$page.url.pathname} />
  </div>
</aside>
