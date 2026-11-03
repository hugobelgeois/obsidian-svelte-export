import * as fs from "fs";
import * as path from "path";

/**
 * A folder of the exported project kept in sync rather than wiped and
 * rewritten on every export: a file only gets copied when its source
 * changed since the last copy (size or modification time), or written when
 * its content changed, and whatever wasn't copied, written or kept during
 * this export is deleted by prune() at the end. On a vault with many
 * images, re-copying all of them was most of an incremental export's time
 * — and an untouched file keeps its mtime, so a running `npm run dev`
 * doesn't reload for nothing.
 *
 * Used for static/ (all of it), src/routes/ (the notes' pages) and src/
 * (svelte-lib/'s files) — each prune()s only what it owns.
 *
 * Names are matched exactly, even on a case-insensitive filesystem
 * (Windows, macOS): a file or folder whose name only changed case
 * ("Arek.png" → "arek.png") takes the new casing, or the site would keep
 * the old one, which GitHub Pages (case-sensitive) then 404s on.
 */
export class SyncedFolder {
	/** Paths copied/written/kept during this export, relative to `dir`,
	 * "/"-separated. */
	private readonly kept = new Set<string>();
	/** Directory → its entries' exact names, read once per directory. */
	private readonly listings = new Map<string, Set<string>>();

	constructor(readonly dir: string) {
		fs.mkdirSync(dir, { recursive: true });
	}

	/** Copies `src` to `rel`, unless already there. */
	copy(src: string, rel: string): void {
		const dest = this.track(rel);
		const srcStat = fs.statSync(src);
		const destStat = this.existingStat(dest);
		if (
			destStat &&
			destStat.size === srcStat.size &&
			Math.abs(destStat.mtimeMs - srcStat.mtimeMs) < 1
		) {
			return;
		}
		this.prepare(dest);
		fs.copyFileSync(src, dest);
		// The source's own mtime, so the next export recognizes the copy
		// (and a source swapped for an older version still differs).
		fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
	}

	/** Writes generated content to `rel`, unless it already holds it. */
	write(rel: string, content: string): void {
		const dest = this.track(rel);
		if (
			this.existingStat(dest) &&
			fs.readFileSync(dest, "utf-8") === content
		) {
			return;
		}
		this.prepare(dest);
		fs.writeFileSync(dest, content, "utf-8");
	}

	/** Keeps `rel` as it is — a file an earlier export wrote that's still
	 * valid (e.g. the page of a note skipped as unchanged). */
	keep(rel: string): void {
		this.track(rel);
	}

	/**
	 * Deletes every file not copied/written/kept during this export — of
	 * those `owned` accepts (path relative to `dir`, "/"-separated), the
	 * rest of the folder being someone else's — then the folders that
	 * deleting them left empty.
	 */
	prune(owned: (rel: string) => boolean = () => true): void {
		/** Whether anything under `dir` was deleted. */
		const walk = (dir: string, prefix: string): boolean => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return false;
			}
			let removed = false;
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				const rel = prefix + entry.name;
				if (entry.isDirectory()) {
					if (walk(full, rel + "/") && !fs.readdirSync(full).length) {
						fs.rmdirSync(full);
						removed = true;
					}
				} else if (!this.kept.has(rel) && owned(rel)) {
					fs.rmSync(full, { force: true });
					removed = true;
				}
			}
			return removed;
		};
		walk(this.dir, "");
	}

	/** Records `rel` as part of the export; returns its absolute path. */
	private track(rel: string): string {
		const parts = rel.replace(/\\/g, "/").split("/");
		this.kept.add(parts.join("/"));
		this.matchFolderCase(parts.slice(0, -1));
		return path.join(this.dir, ...parts);
	}

	/**
	 * Renames an existing folder on the way to a file whose name differs
	 * only in case from the one wanted — files in it would otherwise land in
	 * the old casing, and prune() would then delete them as unknown.
	 */
	private matchFolderCase(folders: string[]): void {
		let dir = this.dir;
		for (const name of folders) {
			const names = this.listing(dir);
			if (!names.has(name)) {
				const lower = name.toLowerCase();
				const old = [...names].find((n) => n.toLowerCase() === lower);
				if (old === undefined) return; // created by prepare()
				fs.renameSync(path.join(dir, old), path.join(dir, name));
				names.delete(old);
				names.add(name);
			}
			dir = path.join(dir, name);
		}
	}

	/**
	 * `dest`'s stats if a file exists there under exactly that name. On a
	 * case-insensitive filesystem "arek.png" also finds an older "Arek.png"
	 * — that one counts as missing, and is removed so the new copy takes
	 * the new casing.
	 */
	private existingStat(dest: string): fs.Stats | null {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(dest);
		} catch {
			return null;
		}
		if (
			stat.isFile() &&
			this.listing(path.dirname(dest)).has(path.basename(dest))
		) {
			return stat;
		}
		fs.rmSync(dest, { recursive: true, force: true });
		return null;
	}

	private listing(dir: string): Set<string> {
		let names = this.listings.get(dir);
		if (!names) {
			names = new Set(fs.readdirSync(dir));
			this.listings.set(dir, names);
		}
		return names;
	}

	/** Creates `dest`'s folder and records its name as present. */
	private prepare(dest: string): void {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		this.listings.get(path.dirname(dest))?.add(path.basename(dest));
	}
}
