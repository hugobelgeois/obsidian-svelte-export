import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import {
	IMAGE_EXTENSIONS,
	sanitizeRoutePath,
	STATIC_PASSTHROUGH_EXTENSIONS,
} from "./constants";
import type SvelteExporterPlugin from "./main";

export type MarkdownStyle = "obsidian" | "custom" | "none";

export interface SvelteExporterSettings {
	destinationPath: string;
	selectedPaths: string[];
	hiddenPaths: string[];
	openAfterExport: boolean;
	markdownStyle: MarkdownStyle;
	customCssPath: string;
	selectedTheme: string; // "" = follow Obsidian, "__none__" = no theme, else theme name
	// "" = welcome screen (default), "__graph__" = graph view as a full page,
	// else a vault file path (from selectedPaths) to redirect "/" to.
	defaultPage: string;
	// Which periodic animation plays in the graph view's big view: "none",
	// or an id matching a filename (without extension) under
	// svelte-lib/lib/animations/ — see the dynamic enumeration in
	// display() below and svelte-lib/lib/animationRegistry.ts. The interval
	// between cycles is fixed in the exported code, not configurable.
	graphAnimationType: string;
	// Which color mode the exported site starts in on first load. The
	// visitor's own toggle (top-right of the graph page, or in the right
	// sidebar elsewhere) still overrides this for the rest of their visit.
	defaultColorMode: "dark" | "light";
	// Color the graph view's big view (popup + full page) using Obsidian's
	// own graph "Groups" (.obsidian/graph.json), so notes matching a saved
	// group query show up in that group's color like they do in Obsidian.
	exportGraphColors: boolean;
	// Vault-relative path to an image used as the exported site's favicon.
	// "" = no custom favicon (browser default).
	faviconPath: string;
	// Vault-relative paths to .js/.ts files copied into the exported site
	// and run on every page — see writeCustomScripts() in main.ts and the
	// import.meta.glob() loader in svelte-lib/routes/+layout.svelte.
	customScriptPaths: string[];
}

export const DEFAULT_SETTINGS: SvelteExporterSettings = {
	destinationPath: "",
	selectedPaths: [],
	hiddenPaths: [],
	openAfterExport: false,
	markdownStyle: "obsidian",
	customCssPath: "",
	selectedTheme: "__none__",
	defaultPage: "",
	graphAnimationType: "heartbeat",
	defaultColorMode: "dark",
	exportGraphColors: true,
	faviconPath: "",
	customScriptPaths: [],
};

// SVG icons for the eye toggle
const EYE_OPEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

export class SvelteExporterSettingTab extends PluginSettingTab {
	plugin: SvelteExporterPlugin;

	// Persist expanded state across re-renders: path → boolean
	private expandedFolders = new Set<string>();
	// Paths recorded in .export-cache.json — i.e. already exported and
	// up-to-date as of the last run. Populated in display(), read by
	// renderFileNode() to show the "✓" indicator.
	private cachedPaths = new Set<string>();

	constructor(app: App, plugin: SvelteExporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Re-render only the file/folder tree, preserving its scroll position —
	 * unlike display() (which rebuilds the whole settings tab and always
	 * resets scroll to the top). Used after every Export/Visible toggle so
	 * cascading state changes (parents, ancestors, children) redraw without
	 * yanking the user back to the top of a long tree.
	 */
	private refreshTree(): void {
		const treeContainer = this.containerEl.querySelector<HTMLElement>(
			".svelte-exporter-tree",
		);
		if (!treeContainer) return;
		const scrollTop = treeContainer.scrollTop;
		treeContainer.empty();
		this.renderTree(treeContainer, this.app.vault.getRoot());
		treeContainer.scrollTop = scrollTop;
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
							const chosen = result?.[0];
							if (chosen) {
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

		// ── Theme ───────────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Appearance" });

		// Enumerate available themes from .obsidian/themes/
		const vaultPath = (this.app.vault.adapter as any).basePath as string;
		const themesDir = require("path").join(
			vaultPath,
			".obsidian",
			"themes",
		);
		const availableThemes: string[] = [];
		if (require("fs").existsSync(themesDir)) {
			for (const entry of require("fs").readdirSync(themesDir, {
				withFileTypes: true,
			})) {
				if (entry.isDirectory()) availableThemes.push(entry.name);
			}
			availableThemes.sort();
		}

		// Dropdown options: default (no theme) + installed themes
		const themeOptions: Record<string, string> = {
			__none__: "Default",
		};
		for (const t of availableThemes) themeOptions[t] = t;

		new Setting(containerEl)
			.setName("Site theme")
			.setDesc(
				"Choose which Obsidian theme to use for the exported site. " +
					"Themes are read from your vault's .obsidian/themes/ folder.",
			)
			.addDropdown((drop) => {
				for (const [value, label] of Object.entries(themeOptions)) {
					drop.addOption(value, label);
				}
				drop.setValue(this.plugin.settings.selectedTheme || "__none__");
				drop.onChange(async (value) => {
					this.plugin.settings.selectedTheme = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Favicon")
			.setDesc(
				"Vault-relative path to an image (png/svg/ico/jpg/…) used as " +
					"the exported site's browser-tab icon. Leave empty for no " +
					"custom favicon.",
			)
			.addText((text) => {
				text.setPlaceholder("Images/logo.png")
					.setValue(this.plugin.settings.faviconPath)
					.onChange(async (value) => {
						this.plugin.settings.faviconPath = value.trim();
						await this.plugin.saveSettings();
					});
				(this as any)._faviconTextComponent = text;
			})
			.addButton((btn) => {
				btn.setButtonText("Browse…")
					.setTooltip("Open a file picker to choose the favicon image")
					.onClick(() => {
						try {
							const { remote } = require("electron");
							const result: string[] | undefined =
								remote.dialog.showOpenDialogSync(
									remote.getCurrentWindow(),
									{
										title: "Select favicon image",
										properties: ["openFile"],
										filters: [
											{
												name: "Images",
												extensions: [...IMAGE_EXTENSIONS, "ico"],
											},
										],
									},
								);
							const chosen = result?.[0];
							if (!chosen) return;
							const vaultPath = (
								this.app.vault.adapter as any
							).basePath as string;
							const normalizedChosen = chosen
								.replace(/\\/g, "/")
								.toLowerCase();
							const normalizedVault = vaultPath
								.replace(/\\/g, "/")
								.toLowerCase();
							if (!normalizedChosen.startsWith(normalizedVault)) {
								new Notice(
									"⚠️ Favicon must be a file inside the vault.",
								);
								return;
							}
							const relative = chosen
								.slice(vaultPath.length)
								.replace(/\\/g, "/")
								.replace(/^\/+/, "");
							this.plugin.settings.faviconPath = relative;
							this.plugin.saveSettings();
							const textCmp = (this as any)._faviconTextComponent;
							if (textCmp) textCmp.setValue(relative);
						} catch (e) {
							new Notice(
								"⚠️ Could not open file picker. Set the path manually.",
							);
							console.error("[SvelteExporter] Browse error:", e);
						}
					});
			});

		new Setting(containerEl)
			.setName("Default color mode")
			.setDesc(
				"Which mode the exported site starts in when a visitor first " +
					"loads it. They can still switch it themselves from the " +
					"toggle in the sidebar (or, on the graph page, top-right).",
			)
			.addDropdown((drop) => {
				drop.addOption("dark", "Dark");
				drop.addOption("light", "Light");
				drop.setValue(this.plugin.settings.defaultColorMode);
				drop.onChange(async (value) => {
					this.plugin.settings.defaultColorMode =
						value === "light" ? "light" : "dark";
					await this.plugin.saveSettings();
				});
			});

		// ── Default page ──────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Default page" });

		const defaultPageOptions: Record<string, string> = {
			"": "Welcome screen (default)",
			__graph__: "Graph view (full page)",
		};
		// One entry per currently-selected markdown file, so the user can
		// pick any exported note as the site's landing page.
		const availablePages = this.plugin
			.resolveFiles(this.plugin.settings.selectedPaths ?? [])
			.filter((f) => f.extension === "md")
			.sort((a, b) => a.path.localeCompare(b.path));
		for (const file of availablePages) {
			const route = "/" + sanitizeRoutePath(file.path);
			defaultPageOptions[route] = file.path;
		}

		new Setting(containerEl)
			.setName("Default page")
			.setDesc(
				"What to show when no specific note is requested (i.e. the " +
					"site's root URL). Choose the welcome screen, the graph " +
					"view as a full page, or one of the notes selected for " +
					"export below.",
			)
			.addDropdown((drop) => {
				for (const [value, label] of Object.entries(
					defaultPageOptions,
				)) {
					drop.addOption(value, label);
				}
				const current = this.plugin.settings.defaultPage ?? "";
				// Fall back to the default if the previously-chosen page is
				// no longer part of the export selection.
				drop.setValue(
					Object.prototype.hasOwnProperty.call(
						defaultPageOptions,
						current,
					)
						? current
						: "",
				);
				drop.onChange(async (value) => {
					this.plugin.settings.defaultPage = value;
					await this.plugin.saveSettings();
				});
			});

		// Enumerate available graph animations from svelte-lib/lib/animations/
		// — each file there is one selectable animation (see
		// svelte-lib/lib/animationRegistry.ts, which loads the same folder
		// at build time). Adding or removing a file changes what's offered
		// here with no other wiring needed.
		const path = require("path");
		const fs = require("fs");
		const pluginDir = path.join(
			vaultPath,
			this.plugin.manifest.dir ??
				`.obsidian/plugins/${this.plugin.manifest.id}`,
		);
		const animationsDir = path.join(
			pluginDir,
			"svelte-lib",
			"lib",
			"animations",
		);
		const animationOptions: Record<string, string> = {
			none: "None",
			random: "Random (a different one each page load)",
		};
		if (fs.existsSync(animationsDir)) {
			const files: string[] = fs
				.readdirSync(animationsDir)
				.filter((f: string) => f.endsWith(".ts") && f !== "types.ts")
				.sort();
			for (const file of files) {
				const id = file.replace(/\.ts$/, "");
				const content = fs.readFileSync(
					path.join(animationsDir, file),
					"utf-8",
				);
				const match = content.match(
					/export const label\s*=\s*["'`](.*?)["'`]/,
				);
				animationOptions[id] = match ? match[1] : id;
			}
		}

		new Setting(containerEl)
			.setName("Graph animation")
			.setDesc(
				"In the graph view's big view (popup and full-page), which " +
					"subtle animation plays every few seconds. Animations are " +
					"plugin files under svelte-lib/lib/animations/ — add or " +
					"remove a file there to change what's offered here. " +
					"Choose \"None\" to disable, or \"Random\" to have each " +
					"page load pick a different one.",
			)
			.addDropdown((drop) => {
				for (const [value, label] of Object.entries(animationOptions)) {
					drop.addOption(value, label);
				}
				const current = this.plugin.settings.graphAnimationType;
				drop.setValue(
					Object.prototype.hasOwnProperty.call(animationOptions, current)
						? current
						: "none",
				);
				drop.onChange(async (value) => {
					this.plugin.settings.graphAnimationType = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Color graph nodes by group")
			.setDesc(
				"In the graph view's big view (popup and full-page), color " +
					"nodes using Obsidian's own graph \"Groups\" " +
					"(the Graph view's Groups tab, saved in .obsidian/graph.json) " +
					"— a note matching a saved group's query is colored the " +
					"same way there. Only path:/file:/tag: queries are " +
					"supported; more complex ones (OR, regex, …) are ignored.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.exportGraphColors)
					.onChange(async (value) => {
						this.plugin.settings.exportGraphColors = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── Custom scripts ──────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Custom scripts" });
		containerEl.createEl("p", {
			text:
				"Import .js/.ts files from your vault to add custom functionality " +
				"to the exported site. Each file's default export (if it's a " +
				"function) runs once, after the page mounts in the visitor's " +
				"browser.",
			cls: "setting-item-description",
		});

		for (const scriptPath of this.plugin.settings.customScriptPaths ?? []) {
			new Setting(containerEl)
				.setName(require("path").basename(scriptPath))
				.setDesc(scriptPath)
				.addButton((btn) => {
					btn.setIcon("trash")
						.setTooltip("Remove")
						.onClick(async () => {
							this.plugin.settings.customScriptPaths =
								this.plugin.settings.customScriptPaths.filter(
									(p) => p !== scriptPath,
								);
							await this.plugin.saveSettings();
							this.display();
						});
				});
		}

		new Setting(containerEl)
			.setName("Add custom script")
			.setDesc("Choose a .js or .ts file from your vault to include.")
			.addButton((btn) => {
				btn.setButtonText("Browse…")
					.setTooltip("Open a file picker to choose a script")
					.onClick(async () => {
						try {
							const { remote } = require("electron");
							const result: string[] | undefined =
								remote.dialog.showOpenDialogSync(
									remote.getCurrentWindow(),
									{
										title: "Select a custom script",
										properties: ["openFile"],
										filters: [
											{
												name: "Scripts",
												extensions: ["js", "ts"],
											},
										],
									},
								);
							const chosen = result?.[0];
							if (!chosen) return;
							const vaultPath = (
								this.app.vault.adapter as any
							).basePath as string;
							const normalizedChosen = chosen
								.replace(/\\/g, "/")
								.toLowerCase();
							const normalizedVault = vaultPath
								.replace(/\\/g, "/")
								.toLowerCase();
							if (!normalizedChosen.startsWith(normalizedVault)) {
								new Notice(
									"⚠️ Script must be a file inside the vault.",
								);
								return;
							}
							const relative = chosen
								.slice(vaultPath.length)
								.replace(/\\/g, "/")
								.replace(/^\/+/, "");
							if (
								!this.plugin.settings.customScriptPaths.includes(
									relative,
								)
							) {
								this.plugin.settings.customScriptPaths.push(
									relative,
								);
								await this.plugin.saveSettings();
							}
							this.display();
						} catch (e) {
							new Notice(
								"⚠️ Could not open file picker. Set the path manually.",
							);
							console.error("[SvelteExporter] Browse error:", e);
						}
					});
			});

		// ── Export cache ──────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Export cache" });

		this.cachedPaths = new Set();
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
				this.cachedPaths = new Set(Object.keys(data));
			} catch {
				/* ignore */
			}
		}
		const cacheSize = this.cachedPaths.size;

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
					STATIC_PASSTHROUGH_EXTENSIONS.has(child.extension)
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
			text: folder.name,
		});

		// Export checkbox
		const exportCb = row.createEl("input", {
			type: "checkbox",
		}) as HTMLInputElement;
		exportCb.title = "Export";
		exportCb.className = "sve-cb";
		// Checked as soon as the folder itself OR any descendant is selected,
		// so checking a single deeply-nested file lights up every ancestor
		// checkbox up the tree (without touching sibling checkboxes).
		exportCb.checked =
			this.plugin.settings.selectedPaths.includes(folder.path) ||
			this.hasPartialSelection(folder);
		exportCb.indeterminate = false;

		// Eye toggle button (visible = not hidden)
		const eyeBtn = row.createEl("button", { cls: "sve-eye-btn" });
		const isHidden =
			this.plugin.settings.hiddenPaths.includes(folder.path) ||
			this.isAncestorHidden(folder);
		eyeBtn.innerHTML = isHidden ? EYE_CLOSED_SVG : EYE_OPEN_SVG;
		eyeBtn.title = isHidden
			? "Hidden from file tree"
			: "Visible in file tree";
		eyeBtn.classList.toggle("sve-eye-hidden", isHidden);
		if (!exportCb.checked) {
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
				// Select folder AND all descendants explicitly (2.1 reverse:
				// checking a parent selects every child).
				this.selectPath(folder.path);
				this.selectAllDescendants(folder);
			} else {
				// 2.1: unchecking a parent deselects every descendant.
				// deselectByPrefix works on the stored path strings directly,
				// so it also clears stale entries left over from files that
				// were since renamed/moved — deselectAllDescendants (which
				// only walks the *current* live vault tree) could leave those
				// behind and make the checkbox impossible to fully uncheck.
				this.deselectByPrefix(folder.path);
				this.deselectHiddenByPrefix(folder.path);
			}
			await this.plugin.saveSettings();
			// Refresh just the tree: ancestors above this folder may also
			// need their checked state recomputed, without resetting scroll.
			this.refreshTree();
		});

		eyeBtn.addEventListener("click", async () => {
			const nowHidden = this.plugin.settings.hiddenPaths.includes(
				folder.path,
			);
			if (nowHidden) {
				// Making a parent visible again makes every descendant
				// explicitly visible too (mirrors Export's uncheck cascade).
				this.deselectHiddenByPrefix(folder.path);
			} else {
				// Hiding a parent explicitly hides every descendant —
				// files AND folders — not just this folder itself.
				this.selectHiddenPath(folder.path);
				this.hideAllDescendants(folder);
			}
			await this.plugin.saveSettings();
			// Same logic as Export: refresh the tree (not just this button)
			// so descendants' disabled/hidden state updates too, without
			// resetting scroll position.
			this.refreshTree();
		});
	}

	private renderFileNode(container: HTMLElement, file: TFile, depth: number) {
		const row = container.createDiv({ cls: "svelte-exporter-row" });
		row.style.paddingLeft = `${depth * 18 + 20}px`;

		const labelWrap = row.createSpan({ cls: "svelte-exporter-label" });
		const isCached = this.cachedPaths.has(file.path);
		const span = labelWrap.createSpan({
			text: `${file.basename}${isCached ? " ✓" : ""}`,
		});
		if (isCached) span.style.color = "var(--text-muted)";
		// Same "nav-file-tag" badge Obsidian's own file explorer shows next to
		// non-markdown files (e.g. "PNG", "JSON") — markdown files get none.
		if (file.extension !== "md") {
			labelWrap.createSpan({ cls: "nav-file-tag", text: file.extension });
		}

		// Export checkbox
		const exportCb = row.createEl("input", {
			type: "checkbox",
		}) as HTMLInputElement;
		exportCb.title = "Export";
		exportCb.className = "sve-cb";
		// Reflects this file's own explicit selection only. When a folder is
		// checked, selectAllDescendants already adds every descendant file to
		// selectedPaths, so this stays accurate — and, unlike before, the
		// checkbox is never disabled: the user can still uncheck this one
		// file even while its parent folder is checked (2.2).
		exportCb.checked = this.plugin.settings.selectedPaths.includes(
			file.path,
		);

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
			await this.plugin.saveSettings();
			// Refresh the tree so every ancestor folder checkbox up the tree
			// recomputes to "checked" (2.3), without resetting scroll.
			this.refreshTree();
		});

		eyeBtn.addEventListener("click", async () => {
			const nowHidden = this.plugin.settings.hiddenPaths.includes(
				file.path,
			);
			if (nowHidden) {
				this.deselectHiddenPath(file.path);
			} else {
				this.selectHiddenPath(file.path);
			}
			await this.plugin.saveSettings();
			this.refreshTree();
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

	/**
	 * Remove `p` itself and every stored path nested under it, by string
	 * prefix — directly on the persisted array, not by walking the live
	 * vault tree. This is what makes unchecking a folder reliable even for
	 * data saved before this fix: if a file was renamed/moved/deleted since
	 * the folder was last checked, its stale entry can no longer be reached
	 * by recursing `folder.children` (deselectAllDescendants), which left it
	 * behind forever and made the checkbox impossible to fully uncheck.
	 */
	private deselectByPrefix(p: string) {
		const prefix = p === "/" ? "" : p + "/";
		this.plugin.settings.selectedPaths =
			this.plugin.settings.selectedPaths.filter(
				(s) => s !== p && !s.startsWith(prefix),
			);
	}

	/** Select ALL current descendants (files + folders) so they show as checked. */
	private selectAllDescendants(folder: TFolder) {
		for (const child of folder.children) {
			this.selectPath(child.path);
			if (child instanceof TFolder) this.selectAllDescendants(child);
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
	private deselectHiddenByPrefix(p: string) {
		const prefix = p === "/" ? "" : p + "/";
		this.plugin.settings.hiddenPaths =
			this.plugin.settings.hiddenPaths.filter(
				(s) => s !== p && !s.startsWith(prefix),
			);
	}

	/**
	 * Mark every current descendant (files AND folders) explicitly hidden —
	 * mirrors selectAllDescendants for Export. Without this, only the
	 * clicked folder's own entry was recorded and children relied purely on
	 * ancestor inheritance (isAncestorHidden) to *look* hidden in the
	 * exported site, but their own eye state here in settings never
	 * reflected it.
	 */
	private hideAllDescendants(folder: TFolder) {
		for (const child of folder.children) {
			this.selectHiddenPath(child.path);
			if (child instanceof TFolder) this.hideAllDescendants(child);
		}
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
      .svelte-exporter-label .nav-file-tag { margin-inline-start: 6px; }

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
