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

/** Reveals `path` in the system file explorer. */
export function openInFileExplorer(path: string): void {
	const { shell } = getElectron();
	void shell.openPath(path);
}
