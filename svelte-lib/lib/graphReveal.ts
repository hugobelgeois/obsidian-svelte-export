/**
 * The standalone graph page's progressive reveal (Graph.svelte): nodes
 * start hidden and pop in one by one — the frame loop calls advance(),
 * graphDraw.ts animates each node's pop-in from its `revealedAt`.
 */
import { REVEAL_FADE_MS } from "$lib/graphDraw";
import type { GNode } from "$lib/graphTypes";

export class ProgressiveReveal {
	/** Node ids, in the order they appear. */
	private readonly order: string[];
	private readonly stepMs: number;
	private cursor = 0;
	/** When the next node is due — 0 until the first frame. */
	private nextAt = 0;

	constructor(
		private readonly nodes: GNode[],
		private readonly adjacency: Map<string, string[]>,
		private readonly nodeIndex: Map<string, GNode>,
	) {
		this.order = this.computeOrder();
		// Stagger tuned so a small vault reveals briskly and a huge one
		// doesn't take forever — capped total runtime, floored per-node step.
		this.stepMs = Math.max(
			25,
			Math.min(70, 4000 / Math.max(this.order.length, 1)),
		);
	}

	/** Whether every node has been revealed (the last ones may still be
	 * fading in). */
	get done(): boolean {
		return this.cursor >= this.order.length;
	}

	/** Whether frames are still needed: nodes left, or a pop-in running. */
	isAnimating(now: number): boolean {
		return !this.done || now < this.nextAt + REVEAL_FADE_MS;
	}

	/** Reveals the next node, if it's due. */
	advance(now: number): void {
		if (this.done) return;
		if (this.nextAt === 0) this.nextAt = now; // the first one right away
		if (now < this.nextAt) return;
		const n = this.nodeIndex.get(this.order[this.cursor++]!);
		if (n) {
			n.revealed = true;
			n.revealedAt = now;
		}
		this.nextAt = now + this.stepMs;
	}

	/**
	 * The most-connected node first, then its neighbors (breadth-first,
	 * each frontier visited most-connected-first), so the reveal grows
	 * outward from each "hub" the same way the eye would explore the graph.
	 * Once a whole connected component is exhausted, jump to the next
	 * most-connected node not yet reached (covers disconnected notes).
	 */
	private computeOrder(): string[] {
		const degree = (id: string) => this.nodeIndex.get(id)?.degree ?? 0;
		const byDegreeDesc = [...this.nodes].sort((a, b) => b.degree - a.degree);
		const visited = new Set<string>();
		const order: string[] = [];

		for (const start of byDegreeDesc) {
			if (visited.has(start.id)) continue;
			// `order` doubles as the BFS queue: everything after `head` is
			// still to visit (no O(n) queue.shift()).
			let head = order.length;
			order.push(start.id);
			visited.add(start.id);
			while (head < order.length) {
				const id = order[head++]!;
				const neighbors = (this.adjacency.get(id) ?? [])
					.filter((nid) => !visited.has(nid))
					.sort((a, b) => degree(b) - degree(a));
				for (const nid of neighbors) {
					visited.add(nid);
					order.push(nid);
				}
			}
		}
		return order;
	}
}
