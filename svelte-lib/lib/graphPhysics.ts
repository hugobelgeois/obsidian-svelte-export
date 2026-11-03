import type { GNode } from "./graphTypes";

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

/** Forces as Obsidian's graph worker receives them — already converted
 * from graph.json's slider positions by the plugin (see obsidianGraph.ts). */
export interface GraphForces {
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
}

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
	 * forceManyBody, computed exactly over every pair — Obsidian uses the
	 * Barnes–Hut approximation of this same sum (theta 0.9), which only
	 * matters for speed on graphs far larger than a typical vault.
	 */
	private applyRepulsion(alpha: number) {
		const k = this.repel * alpha;
		const nodes = this.nodes;
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i]!;
			for (let j = i + 1; j < nodes.length; j++) {
				const b = nodes[j]!;
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				let l = dx * dx + dy * dy;
				if (dx === 0) l += (dx = jiggle()) ** 2;
				if (dy === 0) l += (dy = jiggle()) ** 2;
				if (l < this.repelDistMin2) l = Math.sqrt(this.repelDistMin2 * l);
				const f = k / l;
				a.vx += dx * f;
				a.vy += dy * f;
				b.vx -= dx * f;
				b.vy -= dy * f;
			}
		}
	}

	/** forceCollide (same radius for every node, so each takes half). */
	private applyCollision() {
		const r = this.collideRadius * 2;
		const nodes = this.nodes;
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i]!;
			const xi = a.x + a.vx;
			const yi = a.y + a.vy;
			for (let j = i + 1; j < nodes.length; j++) {
				const b = nodes[j]!;
				let dx = xi - b.x - b.vx;
				let dy = yi - b.y - b.vy;
				let l = dx * dx + dy * dy;
				if (l >= r * r) continue;
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
