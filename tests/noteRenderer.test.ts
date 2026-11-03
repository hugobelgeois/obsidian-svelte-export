import type { App } from "obsidian";
import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import {
	dependencyKey,
	prepareMarkdown,
	type NoteDeps,
} from "../src/noteRenderer";

describe("prepareMarkdown", () => {
	it("lists the code block languages used", () => {
		const { languages } = prepareMarkdown(
			"```js\nx\n```\n\n~~~python\ny\n~~~",
			new Set(),
		);
		expect([...languages].sort()).toEqual(["js", "python"]);
	});

	it("keeps an active integration's blocks for its plugin to render", () => {
		const body = "```statblock\nname: Goblin\n```";
		expect(prepareMarkdown(body, new Set(["statblock"])).markdown).toBe(body);
	});

	it("turns a disabled integration's blocks into plain code", () => {
		const { markdown, languages } = prepareMarkdown(
			"```statblock\nname: Goblin\n```",
			new Set(),
		);
		expect(markdown).toBe("```text\nname: Goblin\n```");
		expect(languages.has("statblock")).toBe(true);
	});

	it("ignores fence-like lines inside another code block", () => {
		const body = "````md\n```statblock\nname: Goblin\n```\n````";
		const { markdown, languages } = prepareMarkdown(body, new Set());
		expect(markdown).toBe(body);
		expect([...languages]).toEqual(["md"]);
	});
});

describe("dependencyKey", () => {
	/** A vault of `files`, where `[[linkpath]]` resolves to `resolves[linkpath]`. */
	function fakeApp(files: TFile[], resolves: Record<string, string> = {}) {
		const byPath = new Map(files.map((f) => [f.path, f]));
		return {
			vault: { getAbstractFileByPath: (p: string) => byPath.get(p) ?? null },
			metadataCache: {
				getFirstLinkpathDest: (lp: string) =>
					byPath.get(resolves[lp] ?? "") ?? null,
			},
		} as unknown as App;
	}
	const deps: NoteDeps = {
		links: ["Linked.md"],
		embeds: ["Embedded.md"],
		unresolved: ["Missing"],
	};
	const exported = new Set(["Page.md", "Linked.md", "Embedded.md"]);
	const files = () => [
		new TFile("Page.md"),
		new TFile("Linked.md"),
		new TFile("Embedded.md", 100),
	];
	const key = (app: App, exportedNotes = exported) =>
		dependencyKey(app, "Page.md", deps, exportedNotes);

	it("is stable while nothing changes", () => {
		expect(key(fakeApp(files()))).toBe(key(fakeApp(files())));
	});

	it("changes when a linked note is removed", () => {
		const without = files().filter((f) => f.path !== "Linked.md");
		expect(key(fakeApp(without))).not.toBe(key(fakeApp(files())));
	});

	it("changes when a linked note leaves the export", () => {
		const fewer = new Set(["Page.md", "Embedded.md"]);
		expect(key(fakeApp(files()), fewer)).not.toBe(key(fakeApp(files())));
	});

	it("changes when an embedded note is edited", () => {
		const edited = files().map((f) =>
			f.path === "Embedded.md" ? new TFile("Embedded.md", 200) : f,
		);
		expect(key(fakeApp(edited))).not.toBe(key(fakeApp(files())));
	});

	it("changes when an unresolved link starts resolving", () => {
		const created = [...files(), new TFile("Missing.md")];
		expect(key(fakeApp(created, { Missing: "Missing.md" }))).not.toBe(
			key(fakeApp(files())),
		);
	});
});
