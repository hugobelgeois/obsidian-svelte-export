<script lang="ts">
  import { onMount } from 'svelte';
  import { tocHeadings } from '$lib/stores';

  let active = $state('');

  onMount(() => {
    const observer = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) { active = e.target.id; break; }
        }
      },
      { rootMargin: '0px 0px -70% 0px', threshold: 0 }
    );
    const unsub = tocHeadings.subscribe(headings => {
      observer.disconnect();
      headings.forEach(h => {
        const el = document.getElementById(h.id);
        if (el) observer.observe(el);
      });
    });
    return () => { observer.disconnect(); unsub(); };
  });
</script>

{#if $tocHeadings.length > 0}
  <div class="toc-title">On this page</div>
  {#each $tocHeadings as h}
    <a href="#{h.id}" class="toc-item h{h.level}" class:active={active === h.id}>
      {h.text}
    </a>
  {/each}
{/if}
