import { App, FileSystemAdapter } from "obsidian";

/**
 * Absolute filesystem path to the vault's root folder. Desktop-only (this
 * plugin already relies on fs/child_process elsewhere), so a non-filesystem
 * adapter (e.g. mobile) is treated as unsupported rather than silently
 * exporting nothing.
 */
export function getVaultBasePath(app: App): string {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		throw new Error(
			"Svelte Exporter requires the desktop app (a filesystem-backed vault).",
		);
	}
	return adapter.getBasePath();
}
