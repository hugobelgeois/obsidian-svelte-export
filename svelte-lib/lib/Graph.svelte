<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { siteTree, flattenTree } from '$lib/siteTree';

  let canvas: HTMLCanvasElement;

  interface GNode { id: string; label: string; x: number; y: number; vx: number; vy: number; }
  interface GLink { source: string; target: string; }

  const files = flattenTree(siteTree);
  const nodes: GNode[] = files.map(f => ({
    id: f.path, label: f.name,
    x: Math.random() * 200 + 20, y: Math.random() * 200 + 20, vx: 0, vy: 0,
  }));

  const links: GLink[] = [];
  files.forEach(f => {
    const parts = f.path.split('/').filter(Boolean);
    if (parts.length > 1) {
      const parentPath = '/' + parts.slice(0, -1).join('/') + '/';
      if (nodes.find(n => n.id === parentPath))
        links.push({ source: parentPath, target: f.path });
    }
  });

  const SZ = 240;

  function simulate() {
    const cx = SZ / 2, cy = SZ / 2;
    for (let iter = 0; iter < 80; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx*dx + dy*dy) || 1;
          const force = 400 / (dist * dist);
          nodes[i].vx -= force*dx/dist; nodes[i].vy -= force*dy/dist;
          nodes[j].vx += force*dx/dist; nodes[j].vy += force*dy/dist;
        }
      }
      links.forEach(l => {
        const s = nodes.find(n => n.id === l.source)!;
        const t = nodes.find(n => n.id === l.target)!;
        if (!s || !t) return;
        const dx = t.x - s.x, dy = t.y - s.y;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1;
        const force = dist * 0.05;
        s.vx += force*dx/dist; s.vy += force*dy/dist;
        t.vx -= force*dx/dist; t.vy -= force*dy/dist;
      });
      nodes.forEach(n => {
        n.vx += (cx - n.x) * 0.01; n.vy += (cy - n.y) * 0.01;
        n.x += n.vx * 0.5; n.y += n.vy * 0.5;
        n.vx *= 0.7; n.vy *= 0.7;
        n.x = Math.max(8, Math.min(SZ-8, n.x));
        n.y = Math.max(8, Math.min(SZ-8, n.y));
      });
    }
  }

  function draw(currentPath: string) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SZ * dpr; canvas.height = SZ * dpr;
    canvas.style.width = SZ + 'px'; canvas.style.height = SZ + 'px';
    ctx.scale(dpr, dpr);
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    ctx.clearRect(0, 0, SZ, SZ);
    links.forEach(l => {
      const s = nodes.find(n => n.id === l.source)!;
      const t = nodes.find(n => n.id === l.target)!;
      if (!s || !t) return;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = isDark ? '#45475a' : '#d0cfc5'; ctx.lineWidth = 1; ctx.stroke();
    });
    nodes.forEach(n => {
      const isCurrent = n.id === currentPath || n.id === currentPath + '/';
      ctx.beginPath(); ctx.arc(n.x, n.y, isCurrent ? 6 : 4, 0, Math.PI*2);
      ctx.fillStyle = isCurrent
        ? (isDark ? '#89b4fa' : '#1e6fbf')
        : (isDark ? '#585b70' : '#bbbbc8');
      ctx.fill();
      if (isCurrent) {
        ctx.font = 'bold 9px system-ui';
        ctx.fillStyle = isDark ? '#cdd6f4' : '#1a1a1a';
        ctx.fillText(n.label, n.x + 8, n.y + 4);
      }
    });
  }

  onMount(() => {
    simulate();
    const unsub = page.subscribe(p => draw(p.url.pathname));
    return unsub;
  });
</script>

<div class="graph-wrap">
  <div class="graph-label">Graph view</div>
  <canvas class="graph-canvas" bind:this={canvas}></canvas>
</div>
