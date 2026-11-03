import { describe, expect, it } from "vitest";
import {
	sanitizeRoutePath,
	slugify,
	staticFilePath,
	staticFileUrl,
} from "../src/constants";

describe("sanitizeRoutePath", () => {
	it("strips .md and transliterates accents", () => {
		expect(sanitizeRoutePath("Règles/Été.md")).toBe("Regles/Ete");
	});

	it("drops quotes and replaces other unsafe characters", () => {
		expect(sanitizeRoutePath("Notes/L'auberge (1).md")).toBe(
			"Notes/Lauberge _1_",
		);
	});

	it("keeps letters, digits, spaces, dots, dashes and underscores", () => {
		expect(sanitizeRoutePath("A b-c_d.e/f.md")).toBe("A b-c_d.e/f");
	});
});

describe("slugify", () => {
	it("lowercases, dashes spaces and drops punctuation", () => {
		expect(slugify("Hello World!")).toBe("hello-world");
	});
});

describe("staticFilePath", () => {
	it("keeps the vault path, so same-named files don't collide", () => {
		expect(staticFilePath("Images/Arek.png")).toBe("Images/Arek.png");
		expect(staticFilePath("Maps/Arek.png")).toBe("Maps/Arek.png");
	});

	it("renames dot-folders, which Vite's dev server doesn't serve", () => {
		expect(staticFilePath(".obsidian/plugins/x/a.png")).toBe(
			"_obsidian/plugins/x/a.png",
		);
	});

	it("normalizes backslashes", () => {
		expect(staticFilePath("Images\\Arek.png")).toBe("Images/Arek.png");
	});
});

describe("staticFileUrl", () => {
	it("prefixes the base-path sentinel and encodes each segment", () => {
		expect(staticFileUrl("Images/Mon image.png")).toBe(
			"%%BASE%%/Images/Mon%20image.png",
		);
	});
});
