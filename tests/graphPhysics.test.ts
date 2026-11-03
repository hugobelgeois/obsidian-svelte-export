import { describe, expect, it } from "vitest";
import {
	ForceSimulation,
	seedPositions,
	WORLD_SCALE,
} from "../svelte-lib/lib/graphPhysics";
import type { GNode } from "../svelte-lib/lib/graphTypes";

const OBSIDIAN_DEFAULTS = {
	centerStrength: 0.1,
	repelStrength: 1000,
	linkStrength: 1,
	linkDistance: 250,
};

/** A binary tree of `n` nodes. */
function makeGraph(n: number) {
	const nodes: GNode[] = Array.from({ length: n }, (_, i) => ({
		id: `n${i}`,
		label: `n${i}`,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		fx: null,
		fy: null,
		degree: 0,
		revealed: true,
		revealedAt: null,
		dimAlpha: 1,
	}));
	const index = new Map(nodes.map((node) => [node.id, node]));
	const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
	const links: { source: GNode; target: GNode }[] = [];
	for (let i = 1; i < n; i++) {
		const j = Math.floor((i - 1) / 2);
		links.push({ source: nodes[i]!, target: nodes[j]! });
		adjacency.get(`n${i}`)!.push(`n${j}`);
		adjacency.get(`n${j}`)!.push(`n${i}`);
	}
	seedPositions(nodes, (id) => adjacency.get(id) ?? [], index);
	return { nodes, links };
}

function runToRest(sim: ForceSimulation, maxTicks = 1000): number {
	let ticks = 0;
	while (sim.running && ticks < maxTicks) {
		sim.tick();
		ticks++;
	}
	return ticks;
}

describe("ForceSimulation", () => {
	it("stops on its own after ~300 ticks, like Obsidian's", () => {
		const { nodes, links } = makeGraph(60);
		const ticks = runToRest(new ForceSimulation(nodes, links, OBSIDIAN_DEFAULTS));
		expect(ticks).toBeGreaterThan(250);
		expect(ticks).toBeLessThanOrEqual(301);
	});

	it("produces finite positions with links near their rest length", () => {
		const { nodes, links } = makeGraph(60);
		runToRest(new ForceSimulation(nodes, links, OBSIDIAN_DEFAULTS));
		expect(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(
			true,
		);
		const lengths = links
			.map((l) => Math.hypot(l.source.x - l.target.x, l.source.y - l.target.y))
			.sort((a, b) => a - b);
		const median = lengths[lengths.length >> 1]!;
		const rest = OBSIDIAN_DEFAULTS.linkDistance * WORLD_SCALE;
		expect(median).toBeGreaterThan(rest * 0.6);
		expect(median).toBeLessThan(rest * 1.6);
	});

	it("keeps nodes apart (collision force)", () => {
		const { nodes, links } = makeGraph(40);
		runToRest(new ForceSimulation(nodes, links, OBSIDIAN_DEFAULTS));
		let closest = Infinity;
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				closest = Math.min(
					closest,
					Math.hypot(nodes[i]!.x - nodes[j]!.x, nodes[i]!.y - nodes[j]!.y),
				);
			}
		}
		// Collision radius 60 per node, scaled: 2 × 60 × WORLD_SCALE apart.
		expect(closest).toBeGreaterThan(2 * 60 * WORLD_SCALE * 0.8);
	});

	it("holds a pinned (dragged) node in place", () => {
		const { nodes, links } = makeGraph(10);
		const pinned = nodes[3]!;
		pinned.fx = 123;
		pinned.fy = -45;
		const sim = new ForceSimulation(nodes, links, OBSIDIAN_DEFAULTS);
		for (let i = 0; i < 50; i++) sim.tick();
		expect(pinned.x).toBe(123);
		expect(pinned.y).toBe(-45);
	});
});
