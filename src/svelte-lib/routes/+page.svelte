<svelte:head><title>My Notes</title></svelte:head>

<div class="welcome">
  <h1>My Notes</h1>
  <p>Select a file in the left sidebar to start reading.</p>
</div>

<style>
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
  }
  .welcome h1 { font-size: 2rem; margin-bottom: .5rem; }
</style>
