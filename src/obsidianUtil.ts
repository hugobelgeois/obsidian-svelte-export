import * as fs from "fs";
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

/**
 * Turns an absolute path picked in a native file dialog into a
 * vault-relative one ("/"-separated), or null if it's outside the vault.
 */
export function toVaultRelativePath(
	vaultPath: string,
	absolutePath: string,
): string | null {
	const normalize = (p: string) => p.replace(/\\/g, "/");
	const vault = normalize(vaultPath).replace(/\/+$/, "");
	const chosen = normalize(absolutePath);
	if (!chosen.toLowerCase().startsWith(vault.toLowerCase() + "/")) return null;
	return chosen.slice(vault.length + 1);
}

/** Parsed JSON file, or `fallback` if it's missing or unreadable. */
export function readJsonFile<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

export function writeJsonFile(filePath: string, data: unknown): void {
	writeFileIfChanged(filePath, JSON.stringify(data, null, 2));
}

/**
 * Writes `content` to `filePath` unless the file already holds exactly
 * that. An unchanged file keeps its mtime, so a running `npm run dev`
 * doesn't reload (or rebuild) for files an export rewrote identically.
 */
function writeFileIfChanged(filePath: string, content: string): void {
	try {
		if (fs.readFileSync(filePath, "utf-8") === content) return;
	} catch {
		// missing or unreadable — written below
	}
	fs.writeFileSync(filePath, content, "utf-8");
}

/** Records the mtime of every exported file — see SiteExporter in exporter.ts. */
export const EXPORT_CACHE_FILE = ".export-cache.json";
