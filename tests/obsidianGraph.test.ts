import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { computeGraphForces } from "../src/obsidianGraph";

describe("computeGraphForces", () => {
	const dirs: string[] = [];
	const obsidianDir = (graphJson?: object) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svelte-export-"));
		dirs.push(dir);
		if (graphJson) {
			fs.writeFileSync(path.join(dir, "graph.json"), JSON.stringify(graphJson));
		}
		return dir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
	});

	it("falls back to the forces of Obsidian's default sliders", () => {
		const forces = computeGraphForces(obsidianDir());
		expect(forces.centerStrength).toBeCloseTo(0.1);
		expect(forces.repelStrength).toBe(1000);
		expect(forces.linkStrength).toBeCloseTo(1);
		expect(forces.linkDistance).toBe(250);
	});

	it("converts slider positions the way Obsidian does", () => {
		const forces = computeGraphForces(
			obsidianDir({
				centerStrength: 1,
				repelStrength: 2,
				linkStrength: 0,
				linkDistance: 100,
			}),
		);
		expect(forces.centerStrength).toBeCloseTo(1);
		expect(forces.repelStrength).toBe(8); // cubed
		expect(forces.linkStrength).toBeCloseTo(0);
		expect(forces.linkDistance).toBe(100);
	});
});
