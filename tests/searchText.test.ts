import { describe, expect, it } from "vitest";
import { fold, prepare, search } from "../svelte-lib/lib/searchText";

describe("fold", () => {
	it("lowercases and strips accents", () => {
		expect(fold("Règles de l'Été").folded).toBe("regles de l'ete");
	});

	it("maps each folded character back to the original", () => {
		const { folded, sourceIndex } = fold("Été");
		expect(sourceIndex).toHaveLength(folded.length);
		expect(sourceIndex).toEqual([0, 1, 2]);
	});
});

describe("search", () => {
	const notes = prepare([
		{ route: "/Regles", title: "Règles", text: "Les règles du jeu de rôle." },
		{ route: "/Bestiaire/Gobelin", title: "Gobelin", text: "Un gobelin rusé qui connaît les règles." },
		{ route: "/Lieux/Auberge", title: "Auberge", text: "Une auberge tranquille." },
	]);

	it("ignores case and accents", () => {
		expect(search(notes, "REGLES").map((h) => h.route)).toContain("/Regles");
	});

	it("ranks name matches first", () => {
		expect(search(notes, "regles")[0]?.route).toBe("/Regles");
	});

	it("requires every word", () => {
		const routes = search(notes, "gobelin regles").map((h) => h.route);
		expect(routes).toEqual(["/Bestiaire/Gobelin"]);
	});

	it("shows the match in its original spelling, with context", () => {
		const [before, match, after] = search(notes, "ruse", 30, 10)[0]!.snippet;
		expect(match).toBe("rusé");
		expect(before.endsWith("gobelin ")).toBe(true);
		expect(after.startsWith(" qui")).toBe(true);
	});

	it("returns nothing for an empty query", () => {
		expect(search(notes, "   ")).toEqual([]);
	});
});
