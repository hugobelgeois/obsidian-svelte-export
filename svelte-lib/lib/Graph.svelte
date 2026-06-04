<script lang="ts">
	import { page } from "$app/stores";
	import { flattenTree, siteTree } from "$lib/siteTree";
	import { onMount } from "svelte";

	let canvas: HTMLCanvasElement;

	interface GNode {
		id: string;
		label: string;
		x: number;
		y: number;
		vx: number;
		vy: number;
	}
	interface GLink {
		source: string;
		target: string;
	}

	const SZ = 240;
	const files = flattenTree(siteTree);

	const nodes: GNode[] = files.map((f) => ({
		id: f.path,
		label: f.name,
		x: Math.random() * (SZ - 16) + 8,
		y: Math.random() * (SZ - 16) + 8,
		vx: 0,
		vy: 0,
	}));

	// Index for O(1) lookup instead of repeated find()
	const nodeIndex = new Map<string, GNode>(nodes.map((n) => [n.id, n]));

	const links: GLink[] = files.flatMap((f) => {
		const parts = f.path.split("/").filter(Boolean);
		if (parts.length < 2) return [];
		const parentPath = "/" + parts.slice(0, -1).join("/") + "/";
		return nodeIndex.has(parentPath)
			? [{ source: parentPath, target: f.path }]
			: [];
	});

	function simulate() {
		const cx = SZ / 2,
			cy = SZ / 2;
		for (let iter = 0; iter < 80; iter++) {
			// Repulsion
			for (let i = 0; i < nodes.length; i++) {
				for (let j = i + 1; j < nodes.length; j++) {
					const dx = nodes[j].x - nodes[i].x;
					const dy = nodes[j].y - nodes[i].y;
					const dist = Math.sqrt(dx * dx + dy * dy) || 1;
					const f = 400 / (dist * dist);
					const fx = (f * dx) / dist,
						fy = (f * dy) / dist;
					nodes[i].vx -= fx;
					nodes[i].vy -= fy;
					nodes[j].vx += fx;
					nodes[j].vy += fy;
				}
			}
			// Attraction along links
			for (const l of links) {
				const s = nodeIndex.get(l.source)!;
				const t = nodeIndex.get(l.target)!;
				if (!s || !t) continue;
				const dx = t.x - s.x,
					dy = t.y - s.y;
				const dist = Math.sqrt(dx * dx + dy * dy) || 1;
				const f = (dist * 0.05) / dist;
				const fx = f * dx,
					fy = f * dy;
				s.vx += fx;
				s.vy += fy;
				t.vx -= fx;
				t.vy -= fy;
			}
			// Integrate + centre gravity + damping
			for (const n of nodes) {
				n.vx += (cx - n.x) * 0.01;
				n.vy += (cy - n.y) * 0.01;
				n.x = Math.max(8, Math.min(SZ - 8, n.x + n.vx * 0.5));
				n.y = Math.max(8, Math.min(SZ - 8, n.y + n.vy * 0.5));
				n.vx *= 0.7;
				n.vy *= 0.7;
			}
		}
	}

	function draw(currentPath: string) {
		if (!canvas) return;
		const ctx = canvas.getContext("2d")!;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = SZ * dpr;
		canvas.height = SZ * dpr;
		canvas.style.width = SZ + "px";
		canvas.style.height = SZ + "px";
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, SZ, SZ);

		// Read colors from CSS variables for theme compatibility
		const style = getComputedStyle(document.body);
		const colorEdge =
			style.getPropertyValue("--background-modifier-border").trim() ||
			"#444";
		const colorNode =
			style.getPropertyValue("--text-muted").trim() || "#888";
		const colorActive =
			style.getPropertyValue("--interactive-accent").trim() || "#7b6cd9";
		const colorLabel =
			style.getPropertyValue("--text-normal").trim() || "#ddd";

		// Edges
		ctx.strokeStyle = colorEdge;
		ctx.lineWidth = 1;
		for (const l of links) {
			const s = nodeIndex.get(l.source)!;
			const t = nodeIndex.get(l.target)!;
			if (!s || !t) continue;
			ctx.beginPath();
			ctx.moveTo(s.x, s.y);
			ctx.lineTo(t.x, t.y);
			ctx.stroke();
		}

		// Nodes
		for (const n of nodes) {
			const isCurrent =
				n.id === currentPath || n.id === currentPath + "/";
			ctx.beginPath();
			ctx.arc(n.x, n.y, isCurrent ? 6 : 4, 0, Math.PI * 2);
			ctx.fillStyle = isCurrent ? colorActive : colorNode;
			ctx.fill();
			if (isCurrent) {
				ctx.font = "bold 9px system-ui";
				ctx.fillStyle = colorLabel;
				ctx.fillText(n.label, n.x + 8, n.y + 4);
			}
		}
	}

	onMount(() => {
		simulate();
		return page.subscribe((p) => draw(p.url.pathname));
	});
</script>

<div class="graph-wrap">
	<div class="graph-label">Graph view</div>
	<canvas class="graph-canvas" bind:this={canvas}></canvas>
</div>
