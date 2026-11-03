// Stand-in for the "obsidian" module in tests (see vitest.config.ts): just
// the runtime values the tested code touches, nothing that renders.

export class TFile {
	stat: { mtime: number };
	constructor(
		public path: string,
		mtime = 0,
	) {
		this.stat = { mtime };
	}
	get extension(): string {
		return this.path.split(".").pop() ?? "";
	}
	get name(): string {
		return this.path.split("/").pop() ?? "";
	}
}

export class FileSystemAdapter {}
export class Component {}
export class Notice {}
export const MarkdownRenderer = {};
export const moment = { locale: () => "en" };
