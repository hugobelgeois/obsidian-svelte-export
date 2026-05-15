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
import type { ExportCache } from "./main";

export interface SvelteExporterSettings {
	destinationPath: string;
	selectedPaths: string[];
	openAfterExport: boolean;
	/** Stores the mtime (ms) of each file at its last successful export. */
	exportCache: ExportCache;
}

export const DEFAULT_SETTINGS: SvelteExporterSettings = {
	destinationPath: "",
	selectedPaths: [],
	openAfterExport: false,
	exportCache: {},
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
							// eslint-disable-next-line @typescript-eslint/no-var-requires
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

		const cacheSize = Object.keys(
			this.plugin.settings.exportCache ?? {},
		).length;

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
						// Refresh the count shown in the description
						this.display();
					});
			});

		// ── File / folder selector ────────────────────────────────────────
		containerEl.createEl("h3", { text: "Files to export" });
		containerEl.createEl("p", {
			text: "Select individual .md files or entire folders. Selecting a folder automatically includes all its nested documents.",
			cls: "setting-item-description",
		});

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
			if (child instanceof TFolder) {
				this.renderFolderNode(container, child, depth);
			} else if (child instanceof TFile && child.extension === "md") {
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

		const arrow = row.createSpan({
			cls: "svelte-exporter-arrow",
			text: "▶",
		});

		const cb = row.createEl("input", {
			type: "checkbox",
		}) as HTMLInputElement;
		cb.checked = this.plugin.settings.selectedPaths.includes(folder.path);
		cb.indeterminate = !cb.checked && this.hasPartialSelection(folder);

		row.createSpan({
			cls: "svelte-exporter-folder-label",
			text: `📁 ${folder.name}`,
		});

		const childrenEl = container.createDiv({
			cls: "svelte-exporter-children",
		});
		childrenEl.style.display = "none";
		this.renderTree(childrenEl, folder, depth + 1);

		let expanded = false;
		const toggle = () => {
			expanded = !expanded;
			childrenEl.style.display = expanded ? "block" : "none";
			arrow.textContent = expanded ? "▼" : "▶";
		};
		arrow.addEventListener("click", toggle);
		row.querySelector(".svelte-exporter-folder-label")?.addEventListener(
			"click",
			toggle,
		);

		cb.addEventListener("change", async () => {
			if (cb.checked) {
				this.selectPath(folder.path);
				this.deselectDescendants(folder);
			} else {
				this.deselectPath(folder.path);
			}
			await this.plugin.saveSettings();
			this.display();
		});
	}

	private renderFileNode(container: HTMLElement, file: TFile, depth: number) {
		const row = container.createDiv({ cls: "svelte-exporter-row" });
		row.style.paddingLeft = `${depth * 18 + 20}px`;

		const cb = row.createEl("input", {
			type: "checkbox",
		}) as HTMLInputElement;
		const ancestorSelected = this.isAncestorSelected(file);
		cb.checked =
			this.plugin.settings.selectedPaths.includes(file.path) ||
			ancestorSelected;
		cb.disabled = ancestorSelected;

		// Show a small "cached" indicator if this file is in the cache
		const isCached = !!this.plugin.settings.exportCache?.[file.path];
		const label = isCached
			? `📄 ${file.basename} ✓`
			: `📄 ${file.basename}`;
		const span = row.createSpan({ text: label });
		if (isCached) span.style.color = "var(--text-muted)";

		cb.addEventListener("change", async () => {
			if (cb.checked) {
				this.selectPath(file.path);
			} else {
				this.deselectPath(file.path);
			}
			await this.plugin.saveSettings();
			this.display();
		});
	}

	// ── Selection helpers ─────────────────────────────────────────────────

	private selectPath(p: string) {
		if (!this.plugin.settings.selectedPaths.includes(p)) {
			this.plugin.settings.selectedPaths.push(p);
		}
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

	private isAncestorSelected(item: TAbstractFile): boolean {
		let parent = item.parent;
		while (parent) {
			if (this.plugin.settings.selectedPaths.includes(parent.path))
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

	// ── Inline styles ─────────────────────────────────────────────────────

	private injectTreeStyles(root: HTMLElement) {
		if (root.querySelector("#svelte-exporter-style")) return;
		const style = root.createEl("style");
		style.id = "svelte-exporter-style";
		style.textContent = `
      .svelte-exporter-tree {
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        padding: 0.5rem 0;
        max-height: 420px;
        overflow-y: auto;
        background: var(--background-primary);
        margin-top: 0.5rem;
        user-select: none;
      }
      .svelte-exporter-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
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
        min-width: 14px;
        text-align: center;
      }
      .svelte-exporter-arrow:hover { color: var(--text-normal); }
      .svelte-exporter-folder-label {
        cursor: pointer;
        font-weight: 500;
      }
      .svelte-exporter-folder-label:hover { color: var(--interactive-accent); }
      .svelte-exporter-row input[type="checkbox"] {
        cursor: pointer;
        flex-shrink: 0;
      }
      .svelte-exporter-row input[type="checkbox"]:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    `;
	}
}
