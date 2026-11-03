import * as fs from "fs";
import { App } from "obsidian";
import * as path from "path";

/**
 * Community plugins whose rendered output gets styled on the exported
 * site. Notes are rendered by Obsidian itself at export time (see
 * noteRenderer.ts), so every plugin's blocks come out as static HTML; an
 * integration adds the plugin's CSS to the pages that use it, strips its
 * interactive bits, and can be turned off in settings.
 *
 * Adding support for another plugin that renders through a fenced code
 * block is usually just one more entry here.
 */
export interface PluginIntegration {
	pluginId: string;
	/** Shown in settings if the plugin's own manifest can't be read. */
	name: string;
	/** Fenced code block languages the plugin registers a processor for. */
	codeBlockLanguages: string[];
	/** Interactive bits to drop from the plugin's rendered blocks, on top
	 * of the generic ones (see noteRenderer.ts). */
	removeSelectors: string[];
	/** <style> elements the plugin injects into document.head at runtime
	 * (rather than shipping in its styles.css) that its output relies on. */
	runtimeStyleSelectors: string[];
}

export const PLUGIN_INTEGRATIONS: PluginIntegration[] = [
	{
		pluginId: "obsidian-5e-statblocks",
		name: "Fantasy Statblocks",
		codeBlockLanguages: ["statblock"],
		// .icons = the hover "…" menu (export as PNG/JSON, edit, …).
		removeSelectors: [".icons", ".statblock-loading"],
		// A layout's custom colors/fonts, injected via insertRule().
		runtimeStyleSelectors: ['style[id^="FS_CSS_PROPERTIES_"]'],
	},
];

interface PluginsInternal {
	manifests: Record<string, { name: string; dir?: string } | undefined>;
	enabledPlugins: Set<string>;
}

/** Obsidian's plugin manager — not part of the public API typings. */
function pluginsOf(app: App): PluginsInternal {
	return (app as unknown as { plugins: PluginsInternal }).plugins;
}

export function isPluginInstalled(app: App, pluginId: string): boolean {
	return !!pluginsOf(app).manifests[pluginId];
}

export function isPluginEnabled(app: App, pluginId: string): boolean {
	return pluginsOf(app).enabledPlugins.has(pluginId);
}

export function pluginDisplayName(app: App, integration: PluginIntegration) {
	return pluginsOf(app).manifests[integration.pluginId]?.name ?? integration.name;
}

/** Integrations both enabled in Obsidian and not turned off in settings. */
export function activeIntegrations(
	app: App,
	disabledIntegrations: string[],
): PluginIntegration[] {
	return PLUGIN_INTEGRATIONS.filter(
		(i) =>
			isPluginEnabled(app, i.pluginId) &&
			!disabledIntegrations.includes(i.pluginId),
	);
}

/**
 * Fingerprint of everything that changes an integration's rendered output
 * (whether it's active, the plugin's version, its settings/layouts) — a
 * page rendered against a different fingerprint must be re-exported even if
 * the note itself hasn't changed.
 */
export function integrationSignature(
	app: App,
	vaultPath: string,
	integration: PluginIntegration,
	active: boolean,
): string {
	if (!active) return "off";
	const dir = pluginDir(app, vaultPath, integration);
	const mtimes = ["manifest.json", "data.json", "styles.css"].map((f) => {
		try {
			return fs.statSync(path.join(dir, f)).mtimeMs;
		} catch {
			return 0;
		}
	});
	return mtimes.join(":");
}

function pluginDir(
	app: App,
	vaultPath: string,
	integration: PluginIntegration,
): string {
	const dir =
		pluginsOf(app).manifests[integration.pluginId]?.dir ??
		`${app.vault.configDir}/plugins/${integration.pluginId}`;
	return path.join(vaultPath, dir);
}

/** The plugin's own styles.css (if any), followed by the runtime CSS
 * captured while rendering. */
export function buildIntegrationCss(
	app: App,
	vaultPath: string,
	integration: PluginIntegration,
	runtimeChunks: Iterable<string>,
): string {
	const parts: string[] = [];
	const stylesPath = path.join(
		pluginDir(app, vaultPath, integration),
		"styles.css",
	);
	if (fs.existsSync(stylesPath)) {
		parts.push(fs.readFileSync(stylesPath, "utf-8"));
	}
	for (const chunk of runtimeChunks) parts.push(chunk);
	return parts.join("\n\n");
}
