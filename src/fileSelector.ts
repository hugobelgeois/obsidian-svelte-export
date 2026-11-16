import { App, setIcon, TAbstractFile, TFile, TFolder } from "obsidian";
import {
	addAncestors,
	foldersFirst,
	isExportable,
	isNote,
	isWithin,
} from "./constants";
import type SvelteExporterPlugin from "./main";
import type { PathList } from "./settings";

/** Counts vault path `p` once for every folder it's under (see
 * addAncestors). */
function countAncestors(p: string, counts: Map<string, number>): void {
	for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
		const folder = p.slice(0, i);
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
	}
}

const BY_FOLDERS_FIRST = foldersFirst<TAbstractFile>(
	(f) => f instanceof TFolder,
	(f) => f.name,
);

/**
 * The settings tab's Export/Visible tree of every vault file and folder.
 * One instance lives as long as the settings tab, so folders stay
 * expanded across its re-renders.
 */
export class FileSelector {
	// Persist expanded state across re-renders: path → boolean
	private expandedFolders = new Set<string>();
	// Paths recorded in .export-cache.json — i.e. already exported and
	// up-to-date as of the last run — shown with a "✓".
	private cachedPaths = new Set<string>();
	// Lookup snapshot of selectedPaths/hiddenPaths, taken once per tree
	// render (see snapshotSelection) — checking the arrays row by row made
	// rendering a big vault's tree quadratic.
	private selected = new Set<string>();
	private hidden = new Set<string>();
	/** Folders with at least one selected path somewhere beneath them. */
	private partiallySelected = new Set<string>();
	/** Folder → exportable files beneath it, at any depth. Counted once per
	 * render() (the tab opened or redrawn) rather than on every toggle's
	 * refresh(): toggling changes the selection, not the vault. */
	private exportableCounts = new Map<string, number>();
	/** Folder → selected exportable files beneath it. Fewer than in
	 * exportableCounts: some file isn't selected — a folder also in
	 * partiallySelected then shows as indeterminate. */
	private selectedCounts = new Map<string, number>();
	private treeContainer: HTMLElement | null = null;

	constructor(
		private readonly app: App,
		private readonly plugin: SvelteExporterPlugin,
	) {}

	render(containerEl: HTMLElement, cachedPaths: Set<string>): void {
		this.cachedPaths = cachedPaths;

		// Column headers
		const headerRow = containerEl.createDiv({ cls: "sve-header-row" });
		headerRow.createSpan({ cls: "sve-header-spacer" });
		headerRow.createSpan({ cls: "sve-col-label", text: "Export" });
		headerRow.createSpan({ cls: "sve-col-label", text: "Visible" });

		this.treeContainer = containerEl.createDiv({
			cls: "svelte-exporter-tree",
		});
		this.exportableCounts = new Map();
		for (const f of this.app.vault.getFiles()) {
			if (isExportable(f)) countAncestors(f.path, this.exportableCounts);
		}
		this.snapshotSelection();
		this.renderTree(this.treeContainer, this.app.vault.getRoot());
	}

	/**
	 * Re-render only the file/folder tree, preserving its scroll position —
	 * unlike the settings tab's display() (which rebuilds the whole tab and
	 * always resets scroll to the top). Used after every Export/Visible
	 * toggle so cascading state changes (parents, ancestors, children)
	 * redraw without yanking the user back to the top of a long tree.
	 */
	private refresh(): void {
		const treeContainer = this.treeContainer;
		if (!treeContainer) return;
		const scrollTop = treeContainer.scrollTop;
		treeContainer.empty();
		this.snapshotSelection();
		this.renderTree(treeContainer, this.app.vault.getRoot());
		treeContainer.scrollTop = scrollTop;
	}

	private snapshotSelection(): void {
		const { selectedPaths, hiddenPaths } = this.plugin.settings;
		this.selected = new Set(selectedPaths);
		this.hidden = new Set(hiddenPaths);
		this.partiallySelected = new Set();
		this.selectedCounts = new Map();
		// Over the selection only, not every file of the vault.
		for (const p of this.selected) {
			addAncestors(p, this.partiallySelected);
			const f = this.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile && isExportable(f)) {
				countAncestors(p, this.selectedCounts);
			}
		}
	}

	/** Whether some exportable file beneath `folder` isn't selected. */
	private hasUnselected(folder: string): boolean {
		return (
			(this.selectedCounts.get(folder) ?? 0) <
			(this.exportableCounts.get(folder) ?? 0)
		);
	}

	private renderTree(container: HTMLElement, folder: TFolder, depth = 0) {
		const sorted = [...folder.children].sort(BY_FOLDERS_FIRST);
		for (const child of sorted) {
			if (child instanceof TFolder) {
				this.renderFolderNode(container, child, depth);
			} else if (child instanceof TFile && isExportable(child)) {
				this.renderFileNode(container, child, depth);
			}
		}
	}

	private renderFolderNode(
		container: HTMLElement,
		folder: TFolder,
		depth: number,
	) {
		const row = container.createDiv({ cls: "svelte-exporter-row" });
		row.style.paddingLeft = `${depth * 18}px`;

		const arrow = row.createSpan({ cls: "svelte-exporter-arrow" });
		const isExpanded = this.expandedFolders.has(folder.path);
		arrow.textContent = isExpanded ? "▼" : "▶";

		const labelWrap = row.createSpan({ cls: "svelte-exporter-label" });
		labelWrap.createSpan({
			cls: "svelte-exporter-folder-label",
			text: folder.name,
		});

		// Export checkbox
		const exportCb = row.createEl("input", {
			type: "checkbox",
			cls: "sve-cb",
			attr: { title: "Export" },
		});
		// Lit up as soon as the folder itself OR any descendant is selected,
		// so checking a single deeply-nested file lights up every ancestor
		// checkbox up the tree (without touching sibling checkboxes) — as
		// indeterminate while some file beneath it isn't selected. Clicking
		// an indeterminate one then selects everything in it.
		const anySelected =
			this.selected.has(folder.path) ||
			this.partiallySelected.has(folder.path);
		exportCb.indeterminate =
			anySelected && this.hasUnselected(folder.path);
		exportCb.checked = anySelected && !exportCb.indeterminate;

		// Eye toggle button (visible = not hidden)
		const eyeBtn = this.createEyeButton(
			row,
			this.hidden.has(folder.path) || this.isAncestorHidden(folder),
			!anySelected,
		);

		// Children container — respects expanded state. Its rows are only
		// built once the folder is first expanded: a big vault's tree is
		// mostly collapsed folders, and every toggle re-renders the tree.
		const childrenEl = container.createDiv({
			cls: "svelte-exporter-children",
		});
		childrenEl.toggleClass("sve-collapsed", !isExpanded);
		let childrenRendered = false;
		const renderChildren = () => {
			if (childrenRendered) return;
			childrenRendered = true;
			this.renderTree(childrenEl, folder, depth + 1);
		};
		if (isExpanded) renderChildren();

		const toggleExpand = () => {
			if (this.expandedFolders.has(folder.path)) {
				this.expandedFolders.delete(folder.path);
				childrenEl.addClass("sve-collapsed");
				arrow.textContent = "▶";
			} else {
				this.expandedFolders.add(folder.path);
				renderChildren();
				childrenEl.removeClass("sve-collapsed");
				arrow.textContent = "▼";
			}
		};
		arrow.addEventListener("click", toggleExpand);
		labelWrap.addEventListener("click", toggleExpand);

		exportCb.addEventListener("change", () =>
			this.update(() => {
				if (exportCb.checked) {
					// Select folder AND all descendants explicitly (2.1 reverse:
					// checking a parent selects every child).
					this.addPath("selectedPaths", folder.path);
					this.addDescendants("selectedPaths", folder);
				} else {
					// 2.1: unchecking a parent deselects every descendant
					// (by prefix — see removeByPrefix).
					this.removeByPrefix("selectedPaths", folder.path);
					this.removeByPrefix("hiddenPaths", folder.path);
				}
			}),
		);

		eyeBtn.addEventListener("click", () =>
			this.update(() => {
				if (this.hidden.has(folder.path)) {
					// Making a parent visible again makes every descendant
					// explicitly visible too (mirrors Export's uncheck cascade).
					this.removeByPrefix("hiddenPaths", folder.path);
				} else {
					// Hiding a parent explicitly hides every descendant —
					// files AND folders — not just this folder itself.
					this.addPath("hiddenPaths", folder.path);
					this.addDescendants("hiddenPaths", folder);
				}
			}),
		);
	}

	private renderFileNode(container: HTMLElement, file: TFile, depth: number) {
		const row = container.createDiv({ cls: "svelte-exporter-row" });
		row.style.paddingLeft = `${depth * 18 + 20}px`;

		const labelWrap = row.createSpan({ cls: "svelte-exporter-label" });
		const isCached = this.cachedPaths.has(file.path);
		labelWrap.createSpan({
			cls: isCached ? "sve-cached-label" : undefined,
			text: `${file.basename}${isCached ? " ✓" : ""}`,
		});
		// Same "nav-file-tag" badge Obsidian's own file explorer shows next to
		// non-markdown files (e.g. "PNG", "JSON") — markdown files get none.
		if (!isNote(file)) {
			labelWrap.createSpan({ cls: "nav-file-tag", text: file.extension });
		}

		// Export checkbox
		const exportCb = row.createEl("input", {
			type: "checkbox",
			cls: "sve-cb",
			attr: { title: "Export" },
		});
		// Reflects this file's own explicit selection only. When a folder is
		// checked, addDescendants already adds every descendant file to
		// selectedPaths, so this stays accurate — and the checkbox is never
		// disabled: the user can still uncheck this one file even while its
		// parent folder is checked (2.2).
		exportCb.checked = this.selected.has(file.path);

		// Eye toggle button
		const ancestorHidden = this.isAncestorHidden(file);
		const eyeBtn = this.createEyeButton(
			row,
			this.hidden.has(file.path) || ancestorHidden,
			ancestorHidden || !exportCb.checked,
		);

		exportCb.addEventListener("change", () =>
			this.update(() => {
				if (exportCb.checked) this.addPath("selectedPaths", file.path);
				else {
					this.removePath("selectedPaths", file.path);
					this.removePath("hiddenPaths", file.path);
				}
			}),
		);

		eyeBtn.addEventListener("click", () =>
			this.update(() => {
				if (this.hidden.has(file.path)) {
					this.removePath("hiddenPaths", file.path);
				} else {
					this.addPath("hiddenPaths", file.path);
				}
			}),
		);
	}

	/** The "Visible" toggle shown on every tree row. */
	private createEyeButton(
		row: HTMLElement,
		isHidden: boolean,
		disabled: boolean,
	): HTMLButtonElement {
		const eyeBtn = row.createEl("button", { cls: "sve-eye-btn" });
		setIcon(eyeBtn, isHidden ? "eye-off" : "eye");
		eyeBtn.title = isHidden ? "Hidden from file tree" : "Visible in file tree";
		eyeBtn.toggleClass("sve-eye-hidden", isHidden);
		if (disabled) {
			eyeBtn.disabled = true;
			eyeBtn.addClass("sve-eye-disabled");
		}
		return eyeBtn;
	}

	/**
	 * Applies an Export/Visible toggle: `change` edits the stored lists, then
	 * they're saved and the tree is refreshed — not just the clicked row, so
	 * every ancestor's checkbox and every descendant's disabled/hidden state
	 * are recomputed too (2.3), without resetting scroll.
	 */
	private update(change: () => void): void {
		change();
		void this.plugin.saveSettings().then(() => this.refresh());
	}

	// ── Selection helpers ─────────────────────────────────────────────────
	// Same operations for both stored lists (see PathList).

	private addPath(list: PathList, p: string) {
		if (!this.plugin.settings[list].includes(p))
			this.plugin.settings[list].push(p);
	}

	private removePath(list: PathList, p: string) {
		this.plugin.settings[list] = this.plugin.settings[list].filter(
			(s) => s !== p,
		);
	}

	/**
	 * Remove `p` itself and every stored path nested under it, by string
	 * prefix — directly on the persisted array, not by walking the live
	 * vault tree, so entries left over from files since renamed, moved or
	 * deleted are cleared too (otherwise a folder's checkbox could become
	 * impossible to fully uncheck).
	 */
	private removeByPrefix(list: PathList, p: string) {
		// The vault root ("/") has everything under it.
		this.plugin.settings[list] = this.plugin.settings[list].filter(
			(s) => p !== "/" && !isWithin(s, p),
		);
	}

	/** Add every current descendant (files AND folders) of `folder`, so each
	 * one's own checkbox/eye reflects the cascade. */
	private addDescendants(list: PathList, folder: TFolder) {
		const paths = new Set(this.plugin.settings[list]);
		const walk = (f: TFolder) => {
			for (const child of f.children) {
				paths.add(child.path);
				if (child instanceof TFolder) walk(child);
			}
		};
		walk(folder);
		this.plugin.settings[list] = [...paths];
	}

	private isAncestorHidden(item: TAbstractFile): boolean {
		for (let parent = item.parent; parent; parent = parent.parent) {
			if (this.hidden.has(parent.path)) return true;
		}
		return false;
	}
}
