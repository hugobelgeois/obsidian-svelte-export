import { App, FileSystemAdapter } from "obsidian";
import * as path from "path";

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

/**
 * Resolves the "Destination path" setting to an absolute path.
 *
 * A relative value (e.g. `../aerethios-page` or `export-site`) is resolved
 * against the vault's own location, so the same setting stays valid when the
 * vault moves between machines/OSes (sync, switching computers, …) as long
 * as the destination sits at a fixed position relative to the vault. An
 * absolute value is used as-is, unchanged, for backward compatibility.
 */
export function resolveDestinationPath(
	vaultPath: string,
	destinationPath: string,
): string {
	if (path.isAbsolute(destinationPath)) return destinationPath;
	// A relative value is meant to be OS-agnostic (typically a vault synced
	// between e.g. Windows and Linux/macOS machines), but Windows' settings
	// UI happily saves backslashes. POSIX's path module doesn't treat "\" as
	// a separator, so an unnormalized "..\site" saved from Windows would
	// resolve on Linux/macOS to one bogus path segment literally named
	// "..\site" instead of being split into its parent/child parts.
	return path.resolve(vaultPath, destinationPath.replace(/\\/g, "/"));
}
