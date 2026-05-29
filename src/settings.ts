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

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"avif",
]);

// SVG icons for the eye toggle
const EYE_OPEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

export class SvelteExporterSettingTab extends PluginSettingTab {
	plugin: SvelteExporterPlugin;

	// Persist expanded state across re-renders: path → boolean
	private expandedFolders = new Set<string>();

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
			text: "Select files and folders to export. Use the eye icon to hide items from the site's file tree while still exporting them.",
			cls: "setting-item-description",
		});

		// Column headers
		const headerRow = containerEl.createDiv({ cls: "sve-header-row" });
		headerRow.createSpan({ cls: "sve-header-spacer" });
		headerRow.createSpan({ cls: "sve-col-label", text: "Export" });
		headerRow.createSpan({ cls: "sve-col-label", text: "Visible" });

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
			} else if (child instanceof TFile) {
				if (
					child.extension === "md" ||
					IMAGE_EXTENSIONS.has(child.extension)
				) {
					this.renderFileNode(container, child, depth);
				}
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

		// Eye toggle button (visible = not hidden)
		const eyeBtn = row.createEl("button", { cls: "sve-eye-btn" });
		const isHidden = this.plugin.settings.hiddenPaths.includes(folder.path);
		eyeBtn.innerHTML = isHidden ? EYE_CLOSED_SVG : EYE_OPEN_SVG;
		eyeBtn.title = isHidden
			? "Hidden from file tree"
			: "Visible in file tree";
		eyeBtn.classList.toggle("sve-eye-hidden", isHidden);
		if (!exportCb.checked && !exportCb.indeterminate) {
			eyeBtn.disabled = true;
			eyeBtn.classList.add("sve-eye-disabled");
		}

		// Children container — respects expanded state
		const childrenEl = container.createDiv({
			cls: "svelte-exporter-children",
		});
		childrenEl.style.display = isExpanded ? "block" : "none";
		this.renderTree(childrenEl, folder, depth + 1);

		const toggleExpand = () => {
			if (this.expandedFolders.has(folder.path)) {
				this.expandedFolders.delete(folder.path);
				childrenEl.style.display = "none";
				arrow.textContent = "▶";
			} else {
				this.expandedFolders.add(folder.path);
				childrenEl.style.display = "block";
				arrow.textContent = "▼";
			}
		};
		arrow.addEventListener("click", toggleExpand);
		labelWrap.addEventListener("click", toggleExpand);

		exportCb.addEventListener("change", async () => {
			if (exportCb.checked) {
				// Select folder AND all descendants explicitly
				this.selectPath(folder.path);
				this.selectAllDescendants(folder);
			} else {
				this.deselectPath(folder.path);
				this.deselectAllDescendants(folder);
				this.deselectHiddenPath(folder.path);
				this.deselectHiddenDescendants(folder);
			}
			await this.plugin.saveSettings();
			// Re-render only the children area to avoid collapsing folders
			childrenEl.empty();
			this.renderTree(childrenEl, folder, depth + 1);
			// Update eye button state
			const nowExported = exportCb.checked;
			eyeBtn.disabled = !nowExported;
			eyeBtn.classList.toggle("sve-eye-disabled", !nowExported);
		});

		eyeBtn.addEventListener("click", async () => {
			const nowHidden = this.plugin.settings.hiddenPaths.includes(
				folder.path,
			);
			if (nowHidden) {
				this.deselectHiddenPath(folder.path);
				eyeBtn.innerHTML = EYE_OPEN_SVG;
				eyeBtn.title = "Visible in file tree";
				eyeBtn.classList.remove("sve-eye-hidden");
			} else {
				this.selectHiddenPath(folder.path);
				this.deselectHiddenDescendants(folder);
				eyeBtn.innerHTML = EYE_CLOSED_SVG;
				eyeBtn.title = "Hidden from file tree";
				eyeBtn.classList.add("sve-eye-hidden");
			}
			await this.plugin.saveSettings();
		});
	}

	private renderFileNode(container: HTMLElement, file: TFile, depth: number) {
		const row = container.createDiv({ cls: "svelte-exporter-row" });
		row.style.paddingLeft = `${depth * 18 + 20}px`;

		const labelWrap = row.createSpan({ cls: "svelte-exporter-label" });
		const isImage = IMAGE_EXTENSIONS.has(file.extension);
		const icon = isImage ? "🖼️" : "📄";
		const isCached = !!this.plugin.settings.exportCache?.[file.path];
		const span = labelWrap.createSpan({
			text: `${icon} ${file.basename}${isCached ? " ✓" : ""}`,
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

		// Eye toggle button
		const eyeBtn = row.createEl("button", { cls: "sve-eye-btn" });
		const ancestorHidden = this.isAncestorHidden(file);
		const isHidden =
			this.plugin.settings.hiddenPaths.includes(file.path) ||
			ancestorHidden;
		eyeBtn.innerHTML = isHidden ? EYE_CLOSED_SVG : EYE_OPEN_SVG;
		eyeBtn.title = isHidden
			? "Hidden from file tree"
			: "Visible in file tree";
		eyeBtn.classList.toggle("sve-eye-hidden", isHidden);
		if (ancestorHidden || !exportCb.checked) {
			eyeBtn.disabled = true;
			eyeBtn.classList.add("sve-eye-disabled");
		}

		exportCb.addEventListener("change", async () => {
			if (exportCb.checked) this.selectPath(file.path);
			else {
				this.deselectPath(file.path);
				this.deselectHiddenPath(file.path);
			}
			eyeBtn.disabled = !exportCb.checked;
			eyeBtn.classList.toggle("sve-eye-disabled", !exportCb.checked);
			await this.plugin.saveSettings();
		});

		eyeBtn.addEventListener("click", async () => {
			const nowHidden = this.plugin.settings.hiddenPaths.includes(
				file.path,
			);
			if (nowHidden) {
				this.deselectHiddenPath(file.path);
				eyeBtn.innerHTML = EYE_OPEN_SVG;
				eyeBtn.title = "Visible in file tree";
				eyeBtn.classList.remove("sve-eye-hidden");
			} else {
				this.selectHiddenPath(file.path);
				eyeBtn.innerHTML = EYE_CLOSED_SVG;
				eyeBtn.title = "Hidden from file tree";
				eyeBtn.classList.add("sve-eye-hidden");
			}
			await this.plugin.saveSettings();
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

	/** Select ALL descendants (files + folders) so they show as checked. */
	private selectAllDescendants(folder: TFolder) {
		for (const child of folder.children) {
			this.selectPath(child.path);
			if (child instanceof TFolder) this.selectAllDescendants(child);
		}
	}
	private deselectAllDescendants(folder: TFolder) {
		for (const child of folder.children) {
			this.deselectPath(child.path);
			if (child instanceof TFolder) this.deselectAllDescendants(child);
		}
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

	// ── Inline styles ─────────────────────────────────────────────────────

	private injectTreeStyles(root: HTMLElement) {
		if (root.querySelector("#svelte-exporter-style")) return;
		const style = root.createEl("style");
		style.id = "svelte-exporter-style";
		style.textContent = `
      .sve-header-row {
        display: flex;
        align-items: center;
        padding: 4px 8px 4px 0;
        font-size: 0.72rem;
        color: var(--text-muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        user-select: none;
      }
      .sve-header-spacer { flex: 1; }
      .sve-col-label {
        width: 52px;
        text-align: center;
        flex-shrink: 0;
      }

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

      .svelte-exporter-row {
        display: flex;
        align-items: center;
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
        min-width: 16px;
        text-align: center;
        flex-shrink: 0;
        margin-right: 4px;
      }
      .svelte-exporter-arrow:hover { color: var(--text-normal); }

      .svelte-exporter-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .svelte-exporter-folder-label {
        cursor: pointer;
        font-weight: 500;
      }
      .svelte-exporter-folder-label:hover { color: var(--interactive-accent); }

      /* Export checkbox */
      .sve-cb {
        width: 52px;
        flex-shrink: 0;
        cursor: pointer;
        margin: 0;
        accent-color: var(--interactive-accent);
      }
      .sve-cb:disabled { opacity: 0.35; cursor: not-allowed; }

      /* Eye button */
      .sve-eye-btn {
        width: 52px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: none;
        border: none;
        padding: 2px;
        cursor: pointer;
        color: var(--interactive-accent);
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
      }
      .sve-eye-btn:hover { background: var(--background-modifier-hover); }
      .sve-eye-btn.sve-eye-hidden {
        color: var(--text-muted);
      }
      .sve-eye-btn.sve-eye-disabled {
        opacity: 0.3;
        cursor: not-allowed;
        pointer-events: none;
      }
    `;
	}
}
