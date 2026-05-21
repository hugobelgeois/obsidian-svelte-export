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


<div class="app-container">
  <div class="horizontal-main-container">
    <div class="workspace is-right-sidedock-open is-left-sidedock-open">
      <div class="workspace-split mod-horizontal mod-sidedock mod-left-split" style="width: 300px;">
      </div>

      <div class="workspace-split mod-vertical mod-root">
        <hr class="workspace-leaf-resize-handle">
        <div class="workspace-tabs mod-top">
          <hr class="workspace-leaf-resize-handle">
          <div class="workspace-tab-container">
            <div class="workspace-leaf">
              <hr class="workspace-leaf-resize-handle">
              <div class="workspace-leaf-content" data-type="empty">
                <div class="view-content"><div class="empty-state">
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="workspace-split mod-horizontal mod-sidedock mod-right-split" style="width: 261.5px;">
      </div>
    </div>
  </div>
</div>
