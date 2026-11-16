import * as fs from "fs";
import {
	App,
	moment,
	Notice,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";
import * as path from "path";
import { IMAGE_EXTENSIONS, isNote, routeOf } from "./constants";
import { OpenDialogOptions, showOpenDialogSync } from "./electronDialog";
import { FileSelector } from "./fileSelector";
import type SvelteExporterPlugin from "./main";
import {
	getVaultBasePath,
	readJsonFile,
	toVaultRelativePath,
} from "./obsidianUtil";
import {
	isPluginEnabled,
	isPluginInstalled,
	PLUGIN_INTEGRATIONS,
	pluginDisplayName,
} from "./pluginIntegrations";

export interface SvelteExporterSettings {
	destinationPath: string;
	selectedPaths: string[];
	hiddenPaths: string[];
	openAfterExport: boolean;
	selectedTheme: string; // "" = follow Obsidian, "__none__" = no theme, else theme name
	// "" = welcome screen (default), "__graph__" = graph view as a full page,
	// else a vault file path (from selectedPaths) to redirect "/" to.
	defaultPage: string;
	// Which periodic animation plays in the graph view's big view: "none",
	// or an id matching a filename (without extension) under
	// svelte-lib/lib/animations/ — see the dynamic enumeration in
	// readAnimationOptions() below and svelte-lib/lib/animationRegistry.ts. The interval
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
	// Public URL of the exported site (e.g. https://user.github.io/repo) —
	// needed for absolute links: link preview images, sitemap. "" = unknown.
	siteUrl: string;
	// <html lang> of the exported site; "" = Obsidian's interface language.
	siteLanguage: string;
	// Vault-relative paths to .js/.ts files copied into the exported site
	// and run on every page — see writeCustomScripts() in siteFiles.ts and the
	// import.meta.glob() loader in svelte-lib/routes/+layout.svelte.
	customScriptPaths: string[];
	// Plugin ids (from PLUGIN_INTEGRATIONS in pluginIntegrations.ts) whose
	// blocks should NOT be rendered into the site. Stored as an opt-out
	// list so every supported plugin — including ones added later — is
	// exported by default.
	disabledIntegrations: string[];
}

export const DEFAULT_SETTINGS: SvelteExporterSettings = {
	destinationPath: "",
	selectedPaths: [],
	hiddenPaths: [],
	openAfterExport: false,
	selectedTheme: "__none__",
	defaultPage: "",
	graphAnimationType: "heartbeat",
	defaultColorMode: "dark",
	exportGraphColors: true,
	faviconPath: "",
	siteUrl: "",
	siteLanguage: "",
	customScriptPaths: [],
	disabledIntegrations: [],
};

/** The two stored path lists: "selectedPaths" (Export) and "hiddenPaths"
 * (Visible) — handled the same way by the file selector and on renames. */
export type PathList = "selectedPaths" | "hiddenPaths";
export const PATH_LISTS: PathList[] = ["selectedPaths", "hiddenPaths"];

/** Settings stored as plain text fields. */
type TextSettingKey = "siteUrl" | "siteLanguage" | "faviconPath";
/** Settings shown as a single toggle. */
type ToggleSettingKey = "openAfterExport" | "exportGraphColors";
/** Settings picked from a dropdown — saved as the chosen option's value. */
type DropdownSettingKey =
	| "selectedTheme"
	| "defaultColorMode"
	| "defaultPage"
	| "graphAnimationType";

export class SvelteExporterSettingTab extends PluginSettingTab {
	plugin: SvelteExporterPlugin;
	private readonly fileSelector: FileSelector;
	// Paths recorded in .export-cache.json — read by renderCache(), shown
	// with a "✓" in the file selector.
	private cachedPaths = new Set<string>();
	// Installed themes and graph animations (value → label) — read from
	// disk once each time the tab is opened, not again on every redraw()
	// (adding/removing a custom script, clearing the cache…).
	private themes: string[] | null = null;
	private animationOptions: Record<string, string> | null = null;

	constructor(app: App, plugin: SvelteExporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.fileSelector = new FileSelector(app, plugin);
	}

	/** Called by Obsidian when the tab is opened. */
	display(): void {
		this.themes = null;
		this.animationOptions = null;
		this.redraw();
	}

	/** Rebuilds the tab after a change made from it. */
	private redraw(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Svelte Exporter").setHeading();

		this.renderGeneral(containerEl);
		this.renderAppearance(containerEl);
		this.renderIntegrations(containerEl);
		this.renderDefaultPage(containerEl);
		this.renderGraph(containerEl);
		this.renderCustomScripts(containerEl);
		this.renderCache(containerEl);
		this.renderFileSelector(containerEl);
	}

	/** Destination folder and what happens after an export. */
	private renderGeneral(containerEl: HTMLElement) {
		// ── Destination path ──────────────────────────────────────────────
		let destText: TextComponent;
		new Setting(containerEl)
			.setName("Destination path")
			.setDesc(
				"Path to the folder where the SvelteKit project will be written. " +
					"The vault directory structure will be reproduced under src/routes/. " +
					"Absolute paths (e.g. C:\\exports\\site or /home/user/site) are used as-is. " +
					"A relative path (e.g. ../aerethios-page) is resolved against the vault's own " +
					"location instead, so it keeps working if the vault moves between machines or OSes.",
			)
			.addText((text) => {
				destText = text;
				text.setPlaceholder("/home/user/my-exported-site")
					.setValue(this.plugin.settings.destinationPath)
					.onChange(async (value) => {
						this.plugin.settings.destinationPath = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton((btn) => {
				btn.setButtonText("Browse…")
					.setTooltip(
						"Open a folder picker to choose the destination",
					)
					.onClick(() => {
						const chosen = this.openDialog(
							{
								title: "Select export destination folder",
								properties: ["openDirectory", "createDirectory"],
							},
							"⚠️ could not open folder picker. Set the path manually.",
						);
						if (chosen === null) return;
						this.plugin.settings.destinationPath = chosen;
						void this.plugin.saveSettings();
						destText.setValue(chosen);
					});
			});

		this.addTextSetting(
			containerEl,
			"siteUrl",
			"Site URL",
			"Public address of the exported site, e.g. " +
				"https://user.github.io/my-site. Used for link previews " +
				"(the image shown when a page is shared on Discord, social " +
				"networks…) and for the sitemap search engines read. " +
				"Leave empty if unknown.",
			"https://user.github.io/my-site",
		);

		this.addTextSetting(
			containerEl,
			"siteLanguage",
			"Site language",
			"Language code of the site's content (e.g. fr, en), used by " +
				"browsers and search engines. Leave empty to use " +
				"Obsidian's interface language.",
			moment.locale(),
		);

		this.addToggleSetting(
			containerEl,
			"openAfterExport",
			"Open destination after export",
			"Automatically open the destination folder in the system file explorer once the export finishes.",
		);
	}

	/** Theme, favicon and default color mode of the exported site. */
	private renderAppearance(containerEl: HTMLElement) {
		// ── Theme ───────────────────────────────────────────────────────────
		new Setting(containerEl).setName("Appearance").setHeading();

		// Dropdown options: default (no theme) + installed themes
		const themeOptions: Record<string, string> = {
			__none__: "Default",
		};
		for (const t of (this.themes ??= this.readThemes())) themeOptions[t] = t;

		this.addDropdownSetting(
			containerEl,
			"selectedTheme",
			"Site theme",
			"Choose which Obsidian theme to use for the exported site. " +
				`Themes are read from your vault's ${this.app.vault.configDir}/themes/ folder.`,
			themeOptions,
			"__none__",
		);

		const favicon = this.addTextSetting(
			containerEl,
			"faviconPath",
			"Favicon",
			"Vault-relative path to an image (png/svg/ico/jpg/…) used as " +
				"the exported site's browser-tab icon. Leave empty for no " +
				"custom favicon.",
			"Images/logo.png",
		);
		favicon.setting.addButton((btn) => {
			btn.setButtonText("Browse…")
				.setTooltip("Open a file picker to choose the favicon image")
				.onClick(() => {
					const relative = this.pickVaultFile(
						"Select favicon image",
						{ name: "Images", extensions: [...IMAGE_EXTENSIONS, "ico"] },
						"⚠️ favicon must be a file inside the vault.",
					);
					if (relative === null) return;
					this.plugin.settings.faviconPath = relative;
					void this.plugin.saveSettings();
					favicon.text.setValue(relative);
				});
		});

		this.addDropdownSetting(
			containerEl,
			"defaultColorMode",
			"Default color mode",
			"Which mode the exported site starts in when a visitor first " +
				"loads it. They can still switch it themselves from the " +
				"toggle in the sidebar (or, on the graph page, top-right).",
			{ dark: "Dark", light: "Light" },
			"dark",
		);
	}

	/** One toggle per supported plugin that's installed. */
	private renderIntegrations(containerEl: HTMLElement) {
		// ── Plugin integrations ───────────────────────────────────────────
		new Setting(containerEl).setName("Plugin integrations").setHeading();

		const installedIntegrations = PLUGIN_INTEGRATIONS.filter((i) =>
			isPluginInstalled(this.app, i.pluginId),
		);
		if (!installedIntegrations.length) {
			new Setting(containerEl).setDesc(
				"No supported plugin is installed. Supported: " +
					PLUGIN_INTEGRATIONS.map((i) => i.name).join(", ") +
					".",
			);
		}
		for (const integration of installedIntegrations) {
			const id = integration.pluginId;
			const languages = integration.codeBlockLanguages
				.map((l) => `"${l}"`)
				.join(", ");
			const enabled = isPluginEnabled(this.app, id);
			new Setting(containerEl)
				.setName(pluginDisplayName(this.app, integration))
				.setDesc(
					`Render ${languages} code blocks on the site the way ` +
						"they look in Obsidian (visual only, without buttons " +
						"or other interactive features)." +
						(enabled
							? ""
							: " This plugin is currently disabled in Obsidian, " +
								"so its blocks are exported as plain code."),
				)
				.addToggle((toggle) =>
					toggle
						.setValue(
							!this.plugin.settings.disabledIntegrations.includes(id),
						)
						.onChange(async (value) => {
							const disabled = new Set(
								this.plugin.settings.disabledIntegrations,
							);
							if (value) disabled.delete(id);
							else disabled.add(id);
							this.plugin.settings.disabledIntegrations = [
								...disabled,
							].sort();
							await this.plugin.saveSettings();
						}),
				);
		}
	}

	/** What the site's root URL shows. */
	private renderDefaultPage(containerEl: HTMLElement) {
		// ── Default page ──────────────────────────────────────────────────
		new Setting(containerEl).setName("Default page").setHeading();

		const defaultPageOptions: Record<string, string> = {
			"": "Welcome screen (default)",
			__graph__: "Graph view (full page)",
		};
		// One entry per currently-selected markdown file, so the user can
		// pick any exported note as the site's landing page.
		const availablePages = this.plugin
			.resolveFiles(this.plugin.settings.selectedPaths)
			.filter(isNote)
			.sort((a, b) => a.path.localeCompare(b.path));
		for (const file of availablePages) {
			defaultPageOptions[routeOf(file.path)] = file.path;
		}

		// Falls back to the welcome screen if the previously-chosen page is
		// no longer part of the export selection.
		this.addDropdownSetting(
			containerEl,
			"defaultPage",
			"Default page",
			"What to show when no specific note is requested (i.e. the " +
				"site's root URL). Choose the welcome screen, the graph " +
				"view as a full page, or one of the notes selected for " +
				"export below.",
			defaultPageOptions,
			"",
		);
	}

	/** Graph view animation and group colors. */
	private renderGraph(containerEl: HTMLElement) {
		const animationOptions = (this.animationOptions ??=
			this.readAnimationOptions());

		this.addDropdownSetting(
			containerEl,
			"graphAnimationType",
			"Graph animation",
			"In the graph view's big view (popup and full-page), which " +
				"subtle animation plays every few seconds. Animations are " +
				"plugin files under svelte-lib/lib/animations/ — add or " +
				"remove a file there to change what's offered here. " +
				"Choose \"None\" to disable, or \"Random\" to have each " +
				"page load pick a different one.",
			animationOptions,
			"none",
		);

		this.addToggleSetting(
			containerEl,
			"exportGraphColors",
			"Color graph nodes by group",
			"In the graph view's big view (popup and full-page), color " +
				"nodes using Obsidian's own graph \"Groups\" " +
				"(the Graph view's Groups tab, saved in " +
				`${this.app.vault.configDir}/graph.json) ` +
				"— a note matching a saved group's query is colored the " +
				"same way there. Only path:/file:/tag: queries are " +
				"supported; more complex ones (OR, regex, …) are ignored.",
		);
	}

	/** The list of custom scripts, plus a picker to add one. */
	private renderCustomScripts(containerEl: HTMLElement) {
		// ── Custom scripts ──────────────────────────────────────────────────
		new Setting(containerEl).setName("Custom scripts").setHeading();
		containerEl.createEl("p", {
			text:
				"Import .js/.ts files from your vault to add custom functionality " +
				"to the exported site. Each file's default export (if it's a " +
				"function) runs once, after the page mounts in the visitor's " +
				"browser.",
			cls: "setting-item-description",
		});

		for (const scriptPath of this.plugin.settings.customScriptPaths) {
			new Setting(containerEl)
				.setName(path.basename(scriptPath))
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
							this.redraw();
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
						const relative = this.pickVaultFile(
							"Select a custom script",
							{ name: "Scripts", extensions: ["js", "ts"] },
							"⚠️ script must be a file inside the vault.",
						);
						if (relative === null) return;
						const scripts = this.plugin.settings.customScriptPaths;
						if (!scripts.includes(relative)) {
							scripts.push(relative);
							await this.plugin.saveSettings();
						}
						this.redraw();
					});
			});
	}

	/** Export cache size, and a button to clear it. */
	private renderCache(containerEl: HTMLElement) {
		// ── Export cache ──────────────────────────────────────────────────
		new Setting(containerEl).setName("Export cache").setHeading();

		const cacheFile = this.plugin.getCacheFilePath();
		this.cachedPaths = new Set(
			Object.keys(cacheFile ? readJsonFile(cacheFile, {}) : {}),
		);
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
					.onClick(() => {
						this.plugin.clearCache();
						new Notice(
							"🗑️ export cache cleared. All files will be re-exported on the next run.",
						);
						this.redraw();
					});
			});
	}

	/** The Export/Visible tree of every vault file and folder. */
	private renderFileSelector(containerEl: HTMLElement) {
		// ── File / folder selector ────────────────────────────────────────
		new Setting(containerEl).setName("Files to export").setHeading();
		containerEl.createEl("p", {
			text: "Select files and folders to export. Use the eye icon to hide items from the site's file tree while still exporting them.",
			cls: "setting-item-description",
		});
		this.fileSelector.render(containerEl, this.cachedPaths);
	}

	// ── Helpers ───────────────────────────────────────────────────────────

	/** Themes installed in the vault's themes/ folder, sorted. */
	private readThemes(): string[] {
		const themesDir = path.join(
			getVaultBasePath(this.app),
			this.app.vault.configDir,
			"themes",
		);
		if (!fs.existsSync(themesDir)) return [];
		return fs
			.readdirSync(themesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	}

	/**
	 * The "Graph animation" choices: none, random, and every animation in
	 * svelte-lib/lib/animations/ — each file there is one (see
	 * svelte-lib/lib/animationRegistry.ts, which loads the same folder at
	 * build time), labelled by its `export const label`. Adding or removing
	 * a file changes what's offered here with no other wiring needed.
	 */
	private readAnimationOptions(): Record<string, string> {
		const animationsDir = path.join(
			this.plugin.getPluginDir(),
			"svelte-lib",
			"lib",
			"animations",
		);
		const options: Record<string, string> = {
			none: "None",
			random: "Random (a different one each page load)",
		};
		if (!fs.existsSync(animationsDir)) return options;
		const files = fs
			.readdirSync(animationsDir)
			.filter((f) => f.endsWith(".ts") && f !== "types.ts")
			.sort();
		for (const file of files) {
			const content = fs.readFileSync(path.join(animationsDir, file), "utf-8");
			const id = file.replace(/\.ts$/, "");
			options[id] =
				content.match(/export const label\s*=\s*["'`](.*?)["'`]/)?.[1] ?? id;
		}
		return options;
	}

	/** A text field saved (trimmed) to `key` on every change. */
	private addTextSetting(
		containerEl: HTMLElement,
		key: TextSettingKey,
		name: string,
		desc: string,
		placeholder: string,
	): { setting: Setting; text: TextComponent } {
		let textComponent!: TextComponent;
		const setting = new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				textComponent = text;
				text.setPlaceholder(placeholder)
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value.trim();
						await this.plugin.saveSettings();
					});
			});
		return { setting, text: textComponent };
	}

	/** A toggle saved to `key` on every change. */
	private addToggleSetting(
		containerEl: HTMLElement,
		key: ToggleSettingKey,
		name: string,
		desc: string,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	/**
	 * A dropdown of `options` (value → label) saved to `key` on every
	 * change. Shows `fallback` while the saved value isn't one of the
	 * options (e.g. a page since deselected, an animation since removed).
	 */
	private addDropdownSetting<K extends DropdownSettingKey>(
		containerEl: HTMLElement,
		key: K,
		name: string,
		desc: string,
		options: Record<string, string>,
		fallback: SvelteExporterSettings[K],
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addDropdown((drop) => {
				drop.addOptions(options);
				const current = this.plugin.settings[key];
				drop.setValue(
					Object.prototype.hasOwnProperty.call(options, current)
						? current
						: fallback,
				);
				drop.onChange(async (value) => {
					// Always one of `options` — the caller's valid values.
					this.plugin.settings[key] = value as SvelteExporterSettings[K];
					await this.plugin.saveSettings();
				});
			});
	}

	/**
	 * Opens the system's open dialog; returns the chosen path, or null if
	 * it was cancelled — or couldn't be opened, after telling the user
	 * (`failMessage`).
	 */
	private openDialog(
		options: OpenDialogOptions,
		failMessage: string,
	): string | null {
		try {
			return showOpenDialogSync(options)?.[0] ?? null;
		} catch (e) {
			new Notice(failMessage);
			console.error("[SvelteExporter] Browse error:", e);
			return null;
		}
	}

	/**
	 * Opens the system's file picker to choose a file inside the vault.
	 * Returns its vault-relative path, or null — after telling the user why,
	 * if it isn't simply a cancelled dialog.
	 */
	private pickVaultFile(
		title: string,
		filter: { name: string; extensions: string[] },
		outsideVaultMessage: string,
	): string | null {
		const chosen = this.openDialog(
			{ title, properties: ["openFile"], filters: [filter] },
			"⚠️ could not open file picker. Set the path manually.",
		);
		if (chosen === null) return null;
		const relative = toVaultRelativePath(getVaultBasePath(this.app), chosen);
		if (relative === null) new Notice(outsideVaultMessage);
		return relative;
	}
}
