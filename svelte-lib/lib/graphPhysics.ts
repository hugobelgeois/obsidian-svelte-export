import { nodeBounds, type GNode } from "./graphTypes";
import type { GraphForces } from "./shared";

/**
 * The same force simulation as Obsidian's own graph view — a port of its
 * graph worker (sim.js, a d3-force setup): center pull (forceX/forceY),
 * link springs (forceLink), node repulsion (forceManyBody) and collision
 * (forceCollide), with the same constants, alpha decay and velocity decay.
 *
 * One difference: every length is multiplied by WORLD_SCALE (and the
 * repulsion strength by WORLD_SCALE², since it acts as strength/distance).
 * Each force is either linear in distance or inverse to it, so this gives
 * exactly Obsidian's layout, uniformly scaled down — to the size the graph
 * animations (lib/animations/) and the rest of Graph.svelte are tuned for.
 */

export const WORLD_SCALE = 0.2;

// Obsidian's fixed constants, in its own units.
const REPEL_DISTANCE_MIN = 30;
const COLLIDE_RADIUS = 60;
const COLLIDE_STRENGTH = 0.5;
/** d3's velocityDecay(0.4): velocities keep 60% each tick. */
const VELOCITY_KEEP = 0.6;
/** Area per node when scattering new nodes (Obsidian: 60 × 60). */
const SEED_AREA_PER_NODE = 60 * 60;

/** The simulation stops once alpha falls below this. */
export const ALPHA_MIN = 0.001;
/** Reaches ALPHA_MIN from 1 in 300 ticks, as in d3/Obsidian. */
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
/** Alpha Obsidian heats the simulation to while a node is dragged. */
export const DRAG_ALPHA = 0.3;

/** d3's tiny random nudge when two points coincide exactly. */
function jiggle(): number {
	return (Math.random() - 0.5) * 1e-6;
}

export class ForceSimulation {
	alpha = 1;
	alphaTarget = 0;

	private readonly center: number;
	private readonly repel: number;
	private readonly repelDistMin2: number;
	private readonly collideRadius: number;
	private readonly links: {
		source: GNode;
		target: GNode;
		strength: number;
		bias: number;
		distance: number;
	}[];

	/** Rebuilt every tick into the same buffers, like the collision grid
	 * below — once they've grown to size, a tick allocates (almost) nothing,
	 * so the graph doesn't stutter on garbage collection. */
	private readonly quadtree = new Quadtree();
	/** Collision grid: cell key → the last node bucketed into that cell;
	 * cellNext[i] → the node bucketed before i in its cell (-1: none). */
	private readonly cellHead = new Map<number, number>();
	private readonly cellNext: Int32Array;
	private readonly cellX: Int32Array;
	private readonly cellY: Int32Array;

	constructor(
		private readonly nodes: GNode[],
		links: { source: GNode; target: GNode }[],
		forces: GraphForces,
	) {
		this.center = forces.centerStrength;
		// Obsidian never lets repulsion drop below 1 (in its units).
		this.repel =
			-Math.max(Math.abs(forces.repelStrength), 1) * WORLD_SCALE ** 2;
		this.repelDistMin2 = (REPEL_DISTANCE_MIN * WORLD_SCALE) ** 2;
		this.collideRadius = COLLIDE_RADIUS * WORLD_SCALE;
		this.cellNext = new Int32Array(nodes.length);
		this.cellX = new Int32Array(nodes.length);
		this.cellY = new Int32Array(nodes.length);

		// forceLink defaults: a link's strength is 1 / the smaller endpoint
		// degree (scaled by Obsidian's link force setting), and each end
		// moves in proportion to the other end's share of links.
		const count = new Map<GNode, number>();
		for (const l of links) {
			count.set(l.source, (count.get(l.source) ?? 0) + 1);
			count.set(l.target, (count.get(l.target) ?? 0) + 1);
		}
		this.links = links.map(({ source, target }) => {
			const cs = count.get(source) ?? 1;
			const ct = count.get(target) ?? 1;
			return {
				source,
				target,
				strength: forces.linkStrength / Math.min(cs, ct),
				bias: cs / (cs + ct),
				distance: forces.linkDistance * WORLD_SCALE,
			};
		});
	}

	/** Whether another tick would still move anything. */
	get running(): boolean {
		return this.alpha > ALPHA_MIN;
	}

	/** Raises alpha to at least `alpha` (Obsidian's "alpha" message). */
	heat(alpha: number): void {
		this.alpha = Math.max(this.alpha, alpha);
	}

	/** One simulation tick — Obsidian runs 60 per second. */
	tick(): void {
		if (!this.running) return;
		this.alpha += (this.alphaTarget - this.alpha) * ALPHA_DECAY;
		const alpha = this.alpha;

		this.applyCenter(alpha);
		this.applyLinks(alpha);
		this.applyRepulsion(alpha);
		this.applyCollision();

		for (const n of this.nodes) {
			if (n.fx === null) n.x += n.vx *= VELOCITY_KEEP;
			else {
				n.x = n.fx;
				n.vx = 0;
			}
			if (n.fy === null) n.y += n.vy *= VELOCITY_KEEP;
			else {
				n.y = n.fy;
				n.vy = 0;
			}
		}
	}

	/** forceX(0) + forceY(0), both at the center force setting. */
	private applyCenter(alpha: number) {
		for (const n of this.nodes) {
			n.vx -= n.x * this.center * alpha;
			n.vy -= n.y * this.center * alpha;
		}
	}

	private applyLinks(alpha: number) {
		for (const l of this.links) {
			const { source: s, target: t } = l;
			let x = t.x + t.vx - s.x - s.vx || jiggle();
			let y = t.y + t.vy - s.y - s.vy || jiggle();
			let len = Math.sqrt(x * x + y * y);
			len = ((len - l.distance) / len) * alpha * l.strength;
			x *= len;
			y *= len;
			t.vx -= x * l.bias;
			t.vy -= y * l.bias;
			s.vx += x * (1 - l.bias);
			s.vy += y * (1 - l.bias);
		}
	}

	/**
	 * forceManyBody with the Barnes–Hut approximation, as in Obsidian
	 * (theta 0.9): a group of nodes far enough away pushes like one body at
	 * their center — O(n log n) per tick instead of every pair's O(n²).
	 */
	private applyRepulsion(alpha: number) {
		if (this.nodes.length < 2) return;
		const tree = this.quadtree;
		tree.build(this.nodes);
		const k = this.repel * alpha;
		for (const node of this.nodes) this.repelFrom(tree, 0, node, k);
	}

	/** Pushes `node` away from every node in quad `q` of `tree`. */
	private repelFrom(tree: Quadtree, q: number, node: GNode, k: number) {
		const dx = tree.x[q]! - node.x;
		const dy = tree.y[q]! - node.y;
		const l = dx * dx + dy * dy;
		const size = tree.size[q]!;
		const first = tree.first[q]!;
		const children = tree.children[q]!;
		if ((size * size) / THETA2 < l) {
			this.repel1(node, dx, dy, l, k * tree.count[q]!);
		} else if (children) {
			for (let c = first; c < first + children; c++) {
				this.repelFrom(tree, c, node, k);
			}
		} else {
			for (let i = first, end = tree.end[q]!; i < end; i++) {
				const other = tree.order[i]!;
				if (other === node) continue;
				const ox = other.x - node.x;
				const oy = other.y - node.y;
				this.repel1(node, ox, oy, ox * ox + oy * oy, k);
			}
		}
	}

	/** Pushes `node` away from a body of strength `k` at (dx, dy) from it,
	 * `l` = the squared distance. */
	private repel1(node: GNode, dx: number, dy: number, l: number, k: number) {
		if (dx === 0) l += (dx = jiggle()) ** 2;
		if (dy === 0) l += (dy = jiggle()) ** 2;
		if (l < this.repelDistMin2) l = Math.sqrt(this.repelDistMin2 * l);
		node.vx += (dx * k) / l;
		node.vy += (dy * k) / l;
	}

	/**
	 * forceCollide (same radius for every node, so each takes half). Nodes
	 * are bucketed by predicted position into cells as wide as the
	 * collision distance, so only nodes in neighboring cells can touch —
	 * the same pairs as checking every one, at O(n) per tick.
	 */
	private applyCollision() {
		const r = this.collideRadius * 2;
		const nodes = this.nodes;
		const { cellHead: head, cellNext: next, cellX: cx, cellY: cy } = this;
		head.clear();
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i]!;
			cx[i] = Math.floor((n.x + n.vx) / r);
			cy[i] = Math.floor((n.y + n.vy) / r);
			const key = cellKey(cx[i]!, cy[i]!);
			next[i] = head.get(key) ?? -1;
			head.set(key, i);
		}
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i]!;
			const xi = a.x + a.vx;
			const yi = a.y + a.vy;
			for (let ox = -1; ox <= 1; ox++) {
				for (let oy = -1; oy <= 1; oy++) {
					const key = cellKey(cx[i]! + ox, cy[i]! + oy);
					for (let j = head.get(key) ?? -1; j !== -1; j = next[j]!) {
						// Each pair once, as a over b (lower index first).
						if (j > i) this.collide(a, nodes[j]!, xi, yi, r);
					}
				}
			}
		}
	}

	/** Separates `a` (predicted at xi, yi) and `b` if closer than `r`. */
	private collide(a: GNode, b: GNode, xi: number, yi: number, r: number) {
		let dx = xi - b.x - b.vx;
		let dy = yi - b.y - b.vy;
		let l = dx * dx + dy * dy;
		if (l >= r * r) return;
		if (dx === 0) l += (dx = jiggle()) ** 2;
		if (dy === 0) l += (dy = jiggle()) ** 2;
		l = Math.sqrt(l);
		l = ((r - l) / l) * COLLIDE_STRENGTH;
		dx *= l;
		dy *= l;
		a.vx += dx * 0.5;
		a.vy += dy * 0.5;
		b.vx -= dx * 0.5;
		b.vy -= dy * 0.5;
	}
}

/** A collision grid cell's Map key — unique while |y| < 2^20 cells. */
function cellKey(x: number, y: number): number {
	return x * 0x200000 + y;
}

// ── Barnes–Hut quadtree (applyRepulsion) ────────────────────────────────────

/** d3's default theta (0.9), squared: a quad whose width is under 0.9 × its
 * distance acts as a single body. */
const THETA2 = 0.81;
/** Deeper than any real layout needs — only stops splitting nodes that sit
 * at the exact same spot. */
const MAX_QUAD_DEPTH = 24;

/**
 * The Barnes–Hut quadtree, as flat arrays indexed by quad (0 = the root)
 * that are reused from one tick to the next. Each quad is a square region:
 * split into up to 4 child quads (quadrant order: top-left, top-right,
 * bottom-left, bottom-right), or a leaf holding a run of `order` — the
 * nodes, partitioned in place so every quad's nodes are contiguous.
 */
class Quadtree {
	order: GNode[] = [];
	/** Mean position of the quad's nodes. */
	x = new Float64Array(64);
	y = new Float64Array(64);
	/** Width of the square. */
	size = new Float64Array(64);
	count = new Int32Array(64);
	/** Number of child quads — 0 for a leaf. */
	children = new Int32Array(64);
	/** Its first child quad (the others follow) — or, for a leaf, the index
	 * in `order` of its first node. */
	first = new Int32Array(64);
	/** Leaf only: the index in `order` just past its last node. */
	end = new Int32Array(64);
	private used = 0;

	build(nodes: GNode[]): void {
		// Same nodes every tick (the simulation's), so last tick's order is
		// kept — already mostly partitioned the way this one needs.
		if (this.order.length !== nodes.length) this.order = nodes.slice();
		const { minX, minY, maxX, maxY } = nodeBounds(nodes);
		const size = Math.max(maxX - minX, maxY - minY, 1e-6);
		this.used = 0;
		this.fill(this.alloc(1), 0, nodes.length, minX, minY, size, 0);
	}

	/** Makes quad `q` the square at (x0, y0) holding order[lo, hi). */
	private fill(
		q: number,
		lo: number,
		hi: number,
		x0: number,
		y0: number,
		size: number,
		depth: number,
	): void {
		const order = this.order;
		let sx = 0;
		let sy = 0;
		for (let i = lo; i < hi; i++) {
			sx += order[i]!.x;
			sy += order[i]!.y;
		}
		const count = hi - lo;
		this.x[q] = sx / count;
		this.y[q] = sy / count;
		this.size[q] = size;
		this.count[q] = count;
		if (count === 1 || depth >= MAX_QUAD_DEPTH) {
			this.children[q] = 0;
			this.first[q] = lo;
			this.end[q] = hi;
			return;
		}
		const half = size / 2;
		const mx = x0 + half;
		const my = y0 + half;
		// Top half (y < my) first, then each half's left (x < mx) part.
		const midY = this.split(lo, hi, my, false);
		const topX = this.split(lo, midY, mx, true);
		const bottomX = this.split(midY, hi, mx, true);
		const children =
			+(topX > lo) + +(midY > topX) + +(bottomX > midY) + +(hi > bottomX);
		// Reserved before recursing, so siblings are consecutive. (The
		// buffers may be swapped for bigger ones meanwhile — always written
		// through `this`, never a reference kept from before.)
		let c = this.alloc(children);
		this.children[q] = children;
		this.first[q] = c;
		const d = depth + 1;
		if (topX > lo) this.fill(c++, lo, topX, x0, y0, half, d);
		if (midY > topX) this.fill(c++, topX, midY, mx, y0, half, d);
		if (bottomX > midY) this.fill(c++, midY, bottomX, x0, my, half, d);
		if (hi > bottomX) this.fill(c++, bottomX, hi, mx, my, half, d);
	}

	/** Moves the nodes of order[lo, hi) below `mid` (on x, or on y) before
	 * the others; returns where the others start. */
	private split(lo: number, hi: number, mid: number, onX: boolean): number {
		const order = this.order;
		let i = lo;
		let j = hi - 1;
		for (;;) {
			while (i <= j && (onX ? order[i]!.x : order[i]!.y) < mid) i++;
			while (i <= j && !((onX ? order[j]!.x : order[j]!.y) < mid)) j--;
			if (i >= j) return i;
			const t = order[i]!;
			order[i++] = order[j]!;
			order[j--] = t;
		}
	}

	/** Reserves `k` consecutive quads; returns the first one. */
	private alloc(k: number): number {
		const at = this.used;
		this.used += k;
		if (this.used > this.x.length) {
			let capacity = this.x.length * 2;
			while (capacity < this.used) capacity *= 2;
			const growF = (a: Float64Array) => {
				const b = new Float64Array(capacity);
				b.set(a);
				return b;
			};
			const growI = (a: Int32Array) => {
				const b = new Int32Array(capacity);
				b.set(a);
				return b;
			};
			this.x = growF(this.x);
			this.y = growF(this.y);
			this.size = growF(this.size);
			this.count = growI(this.count);
			this.children = growI(this.children);
			this.first = growI(this.first);
			this.end = growI(this.end);
		}
		return at;
	}
}

/**
 * Obsidian's initial placement: each node goes next to the average
 * position of its already-placed neighbors (± a random offset), or, with
 * none placed yet, somewhere random in a disc sized for the whole graph.
 */
export function seedPositions(
	nodes: GNode[],
	neighbors: (id: string) => string[],
	nodeIndex: Map<string, GNode>,
): void {
	const area = SEED_AREA_PER_NODE * nodes.length * WORLD_SCALE ** 2;
	const discRadius = Math.sqrt(area / Math.PI);
	const spread = Math.sqrt(area);
	const placed = new Set<GNode>();

	for (const n of nodes) {
		let sx = 0;
		let sy = 0;
		let count = 0;
		for (const id of neighbors(n.id)) {
			const other = nodeIndex.get(id);
			if (other && placed.has(other)) {
				sx += other.x;
				sy += other.y;
				count++;
			}
		}
		if (count > 0) {
			n.x = sx / count + (Math.random() - 0.5) * spread;
			n.y = sy / count + (Math.random() - 0.5) * spread;
		} else {
			const angle = 2 * Math.random() * Math.PI;
			const radius = Math.sqrt(Math.random()) * discRadius;
			n.x = radius * Math.cos(angle);
			n.y = radius * Math.sin(angle);
		}
		n.vx = 0;
		n.vy = 0;
		n.fx = null;
		n.fy = null;
		placed.add(n);
	}
}
