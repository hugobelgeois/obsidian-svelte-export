import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import type SvelteExporterPlugin from "./main";

export interface SvelteExporterSettings {
	destinationPath: string;
	selectedPaths: string[];
	hiddenPaths: string[];
	openAfterExport: boolean;
}

export const DEFAULT_SETTINGS: SvelteExporterSettings = {
	destinationPath: "",
	selectedPaths: [],
	hiddenPaths: [],
	openAfterExport: false,
};

export class SvelteExporterSettingTab extends PluginSettingTab {
	plugin: SvelteExporterPlugin;

	constructor(app: App, plugin: SvelteExporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Svelte Exporter" });

		// ── Destination path ──────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Destination path")
			.setDesc(
				"Absolute path to the folder where the SvelteKit project will be written. " +
					"The vault directory structure will be reproduced under src/routes/.",
			)
			.addText((text) => {
				text.setPlaceholder("/home/user/my-svelte-site")
					.setValue(this.plugin.settings.destinationPath)
					.onChange(async (value) => {
						this.plugin.settings.destinationPath = value.trim();
						await this.plugin.saveSettings();
					});
				(this as any)._destTextComponent = text;
			})
			.addButton((btn) => {
				btn.setButtonText("Browse…")
					.setTooltip(
						"Open a folder picker to choose the destination",
					)
					.onClick(() => {
						try {
							const { remote } = require("electron");
							const result: string[] | undefined =
								remote.dialog.showOpenDialogSync(
									remote.getCurrentWindow(),
									{
										title: "Select export destination folder",
										properties: [
											"openDirectory",
											"createDirectory",
										],
									},
								);
							if (result && result.length > 0) {
								const chosen = result[0];
								this.plugin.settings.destinationPath = chosen;
								this.plugin.saveSettings();
								const textCmp = (this as any)
									._destTextComponent;
								if (textCmp) textCmp.setValue(chosen);
							}
						} catch (e) {
							new Notice(
								"⚠️ Could not open folder picker. Set the path manually.",
							);
							console.error("[SvelteExporter] Browse error:", e);
						}
					});
			});

		// ── Open after export ─────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Open destination after export")
			.setDesc(
				"Automatically open the destination folder in the system file explorer once the export finishes.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openAfterExport)
					.onChange(async (value) => {
						this.plugin.settings.openAfterExport = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── Export cache ──────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Export cache" });

		let cacheSize = 0;
		const cacheFile = this.plugin.settings.destinationPath
			? require("path").join(
					this.plugin.settings.destinationPath,
					".export-cache.json",
				)
			: null;
		if (cacheFile && require("fs").existsSync(cacheFile)) {
			try {
				const data = JSON.parse(
					require("fs").readFileSync(cacheFile, "utf-8"),
				);
				cacheSize = Object.keys(data).length;
			} catch {
				/* ignore */
			}
		}

		new Setting(containerEl)
			.setName("Clear export cache")
			.setDesc(
				`The cache records the last-modified time of each exported file so unchanged files are skipped on the next export. ` +
					`Currently tracking ${cacheSize} file${cacheSize !== 1 ? "s" : ""}. ` +
					`Clearing the cache forces a full re-export on the next run.`,
			)
			.addButton((btn) => {
				btn.setButtonText("Clear cache")
					.setWarning()
					.onClick(async () => {
						await this.plugin.clearCache();
						new Notice(
							"🗑️ Export cache cleared. All files will be re-exported on the next run.",
						);
						this.display();
					});
			});

		// ── File / folder selector ────────────────────────────────────────
		containerEl.createEl("h3", { text: "Files to export" });
		containerEl.createEl("p", {
			text: "Export: include in the export. Hidden: exported but not shown in the file tree.",
			cls: "setting-item-description",
		});

		// Column headers — aligned above the two checkbox columns
		const headerRow = containerEl.createDiv({ cls: "sve-header-row" });
		headerRow.createSpan({ cls: "sve-header-spacer" });
		headerRow.createSpan({ cls: "sve-col-label", text: "Export" });
		headerRow.createSpan({ cls: "sve-col-label", text: "Hidden" });

		const treeContainer = containerEl.createDiv({
			cls: "svelte-exporter-tree",
		});
		this.injectTreeStyles(containerEl);
		this.renderTree(treeContainer, this.app.vault.getRoot());
	}

	// ── Tree rendering ────────────────────────────────────────────────────

	private renderTree(container: HTMLElement, folder: TFolder, depth = 0) {
		const sorted = [...folder.children].sort((a, b) => {
			const aIsFolder = a instanceof TFolder ? 0 : 1;
			const bIsFolder = b instanceof TFolder ? 0 : 1;
			if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
			return a.name.localeCompare(b.name);
		});
		for (const child of sorted) {
			if (child instanceof TFolder)
				this.renderFolderNode(container, child, depth);
			else if (child instanceof TFile && child.extension === "md")
				this.renderFileNode(container, child, depth);
		}
	}

	private renderFolderNode(
		container: HTMLElement,
		folder: TFolder,
		depth: number,
	) {
		const row = container.createDiv({ cls: "svelte-exporter-row" });
		row.style.paddingLeft = `${depth * 18}px`;

		const arrow = row.createSpan({
			cls: "svelte-exporter-arrow",
			text: "▶",
		});

		// Label first so checkboxes stay on the right
		const labelWrap = row.createSpan({ cls: "svelte-exporter-label" });
		labelWrap.createSpan({
			cls: "svelte-exporter-folder-label",
			text: `📁 ${folder.name}`,
		});

		// Export checkbox
		const exportCb = row.createEl("input", {
			type: "checkbox",
		}) as HTMLInputElement;
		exportCb.title = "Export";
		exportCb.className = "sve-cb";
		exportCb.checked = this.plugin.settings.selectedPaths.includes(
			folder.path,
		);
		exportCb.indeterminate =
			!exportCb.checked && this.hasPartialSelection(folder);

		// Hidden checkbox
		const hiddenCb = row.createEl("input", {
			type: "checkbox",
		}) as HTMLInputElement;
		hiddenCb.title = "Hidden";
		hiddenCb.className = "sve-cb";
		hiddenCb.checked = this.plugin.settings.hiddenPaths.includes(
			folder.path,
		);
		hiddenCb.indeterminate =
			!hiddenCb.checked && this.hasPartialHidden(folder);
		if (!exportCb.checked && !exportCb.indeterminate)
			hiddenCb.disabled = true;

		const childrenEl = container.createDiv({
			cls: "svelte-exporter-children",
		});
		childrenEl.style.display = "none";
		this.renderTree(childrenEl, folder, depth + 1);

		let expanded = false;
		const toggleExpand = () => {
			expanded = !expanded;
			childrenEl.style.display = expanded ? "block" : "none";
			arrow.textContent = expanded ? "▼" : "▶";
		};
		arrow.addEventListener("click", toggleExpand);
		labelWrap.addEventListener("click", toggleExpand);

		exportCb.addEventListener("change", async () => {
			if (exportCb.checked) {
				this.selectPath(folder.path);
				this.deselectDescendants(folder);
			} else {
				this.deselectPath(folder.path);
				this.deselectHiddenPath(folder.path);
				this.deselectHiddenDescendants(folder);
			}
			hiddenCb.disabled = !exportCb.checked && !exportCb.indeterminate;
			await this.plugin.saveSettings();
			this.display();
		});

		hiddenCb.addEventListener("change", async () => {
			if (hiddenCb.checked) {
				this.selectHiddenPath(folder.path);
				this.deselectHiddenDescendants(folder);
			} else {
				this.deselectHiddenPath(folder.path);
			}
			await this.plugin.saveSettings();
			this.display();
		});
	}

	private renderFileNode(container: HTMLElement, file: TFile, depth: number) {
		const row = container.createDiv({ cls: "svelte-exporter-row" });
		row.style.paddingLeft = `${depth * 18 + 20}px`;

		const labelWrap = row.createSpan({ cls: "svelte-exporter-label" });
		const isCached = !!this.plugin.settings.exportCache?.[file.path];
		const span = labelWrap.createSpan({
			text: isCached ? `📄 ${file.basename} ✓` : `📄 ${file.basename}`,
		});
		if (isCached) span.style.color = "var(--text-muted)";

		// Export checkbox
		const exportCb = row.createEl("input", {
			type: "checkbox",
		}) as HTMLInputElement;
		exportCb.title = "Export";
		exportCb.className = "sve-cb";
		const ancestorSelected = this.isAncestorSelected(file);
		exportCb.checked =
			this.plugin.settings.selectedPaths.includes(file.path) ||
			ancestorSelected;
		exportCb.disabled = ancestorSelected;

		// Hidden checkbox
		const hiddenCb = row.createEl("input", {
			type: "checkbox",
		}) as HTMLInputElement;
		hiddenCb.title = "Hidden";
		hiddenCb.className = "sve-cb";
		const ancestorHidden = this.isAncestorHidden(file);
		hiddenCb.checked =
			this.plugin.settings.hiddenPaths.includes(file.path) ||
			ancestorHidden;
		hiddenCb.disabled = ancestorHidden || !exportCb.checked;

		exportCb.addEventListener("change", async () => {
			if (exportCb.checked) this.selectPath(file.path);
			else {
				this.deselectPath(file.path);
				this.deselectHiddenPath(file.path);
			}
			hiddenCb.disabled = !exportCb.checked;
			await this.plugin.saveSettings();
			this.display();
		});

		hiddenCb.addEventListener("change", async () => {
			if (hiddenCb.checked) this.selectHiddenPath(file.path);
			else this.deselectHiddenPath(file.path);
			await this.plugin.saveSettings();
			this.display();
		});
	}

	// ── Selection helpers ─────────────────────────────────────────────────

	private selectPath(p: string) {
		if (!this.plugin.settings.selectedPaths.includes(p))
			this.plugin.settings.selectedPaths.push(p);
	}
	private deselectPath(p: string) {
		this.plugin.settings.selectedPaths =
			this.plugin.settings.selectedPaths.filter((s) => s !== p);
	}
	private deselectDescendants(folder: TFolder) {
		const prefix = folder.path === "/" ? "" : folder.path + "/";
		this.plugin.settings.selectedPaths =
			this.plugin.settings.selectedPaths.filter(
				(p) => !p.startsWith(prefix),
			);
	}
	private selectHiddenPath(p: string) {
		if (!this.plugin.settings.hiddenPaths.includes(p))
			this.plugin.settings.hiddenPaths.push(p);
	}
	private deselectHiddenPath(p: string) {
		this.plugin.settings.hiddenPaths =
			this.plugin.settings.hiddenPaths.filter((s) => s !== p);
	}
	private deselectHiddenDescendants(folder: TFolder) {
		const prefix = folder.path === "/" ? "" : folder.path + "/";
		this.plugin.settings.hiddenPaths =
			this.plugin.settings.hiddenPaths.filter(
				(p) => !p.startsWith(prefix),
			);
	}
	private isAncestorSelected(item: TAbstractFile): boolean {
		let parent = item.parent;
		while (parent) {
			if (this.plugin.settings.selectedPaths.includes(parent.path))
				return true;
			parent = parent.parent;
		}
		return false;
	}
	private isAncestorHidden(item: TAbstractFile): boolean {
		let parent = item.parent;
		while (parent) {
			if (this.plugin.settings.hiddenPaths.includes(parent.path))
				return true;
			parent = parent.parent;
		}
		return false;
	}
	private hasPartialSelection(folder: TFolder): boolean {
		const prefix = folder.path === "/" ? "" : folder.path + "/";
		return this.plugin.settings.selectedPaths.some((p) =>
			p.startsWith(prefix),
		);
	}
	private hasPartialHidden(folder: TFolder): boolean {
		const prefix = folder.path === "/" ? "" : folder.path + "/";
		return this.plugin.settings.hiddenPaths.some((p) =>
			p.startsWith(prefix),
		);
	}

	// ── Inline styles ─────────────────────────────────────────────────────

	private injectTreeStyles(root: HTMLElement) {
		if (root.querySelector("#svelte-exporter-style")) return;
		const style = root.createEl("style");
		style.id = "svelte-exporter-style";
		style.textContent = `
      /* Header row above the tree */
      .sve-header-row {
        display: flex;
        align-items: center;
        padding: 2px 8px 2px 0;
        font-size: 0.72rem;
        color: var(--text-muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        user-select: none;
      }
      .sve-header-spacer { flex: 1; }
      .sve-col-label {
        width: 44px;
        text-align: center;
        flex-shrink: 0;
      }

      /* Tree container */
      .svelte-exporter-tree {
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        padding: 0.5rem 0;
        max-height: 420px;
        overflow-y: auto;
        background: var(--background-primary);
        margin-top: 0.25rem;
        user-select: none;
      }

      /* Each row: label takes available space, two checkboxes fixed width */
      .svelte-exporter-row {
        display: flex;
        align-items: center;
        gap: 0;
        padding: 3px 8px 3px 8px;
        cursor: default;
        font-size: 0.9rem;
        color: var(--text-normal);
        transition: background 0.1s;
      }
      .svelte-exporter-row:hover {
        background: var(--background-modifier-hover);
        border-radius: 4px;
      }

      .svelte-exporter-arrow {
        font-size: 0.65rem;
        color: var(--text-muted);
        cursor: pointer;
        min-width: 16px;
        text-align: center;
        flex-shrink: 0;
        margin-right: 4px;
      }
      .svelte-exporter-arrow:hover { color: var(--text-normal); }

      /* Label stretches */
      .svelte-exporter-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .svelte-exporter-folder-label {
        cursor: pointer;
        font-weight: 500;
      }
      .svelte-exporter-folder-label:hover { color: var(--interactive-accent); }

      /* Checkboxes: fixed 44px wide to match column headers */
      .sve-cb {
        width: 44px;
        flex-shrink: 0;
        cursor: pointer;
        /* center the native checkbox within its column */
        margin: 0;
        display: block;
        text-align: center;
        accent-color: var(--interactive-accent);
      }
      .sve-cb:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
    `;
	}
}
