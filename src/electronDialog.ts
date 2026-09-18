/**
 * Thin, typed wrapper around the bits of Electron used by this plugin
 * (native file/folder pickers, revealing a path in the system file
 * explorer) — available in Obsidian's desktop app, but with no official
 * `@types/electron` package installed, so the untyped `require("electron")`
 * boundary is isolated to this one file instead of scattering `any` through
 * main.ts/settings.ts.
 */

interface OpenDialogOptions {
	title: string;
	properties: string[];
	filters?: { name: string; extensions: string[] }[];
}

interface ElectronRemote {
	dialog: {
		showOpenDialogSync: (
			window: unknown,
			options: OpenDialogOptions,
		) => string[] | undefined;
	};
	getCurrentWindow: () => unknown;
}

interface ElectronShell {
	openPath: (path: string) => Promise<string>;
}

function getElectron(): { remote: ElectronRemote; shell: ElectronShell } {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- electron has no @types package; only resolvable at runtime, in Obsidian's desktop shell.
	return require("electron") as { remote: ElectronRemote; shell: ElectronShell };
}

/**
 * Opens a native "choose folder"/"choose file" dialog. Returns the chosen
 * path(s), or `undefined` if the user cancelled.
 */
export function showOpenDialogSync(
	options: OpenDialogOptions,
): string[] | undefined {
	const { remote } = getElectron();
	return remote.dialog.showOpenDialogSync(remote.getCurrentWindow(), options);
}

/**
 * Reveals `path` in the system file explorer.
 *
 * `shell.openPath` never rejects on failure — it resolves with a
 * human-readable error string instead (empty string on success) — so that
 * string is turned into a thrown error here for callers to catch normally.
 */
export async function openInFileExplorer(path: string): Promise<void> {
	const { shell } = getElectron();
	const error = await shell.openPath(path);
	if (error) throw new Error(error);
}
