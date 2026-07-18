// import.meta.glob instead of a static `import ... from "$lib/nameMap.json"`:
// a static import fails the whole Vite build if nameMap.json doesn't exist
// yet (e.g. right after updating the plugin's svelte-lib files but before
// the very first export has run). The glob form simply returns an empty
// result set instead of erroring.
const nameMapModules = import.meta.glob("./nameMap.json", {
	eager: true,
}) as Record<string, { default?: Record<string, string> }>;
const nameMap: Record<string, string> =
	Object.values(nameMapModules)[0]?.default ?? {};

export interface TreeNode {
	name: string;
	path: string;
	depth: number;
	children?: TreeNode[];
}

const modules = import.meta.glob("/src/routes/**/+page.svelte");

function buildTree(): TreeNode[] {
	const paths = Object.keys(modules)
		.map(
			(p) =>
				p
					.replace("/src/routes", "")
					.replace("/+page.svelte", "")
					.replace(/\/$/, "") || "/",
		)
		.filter((p) => p !== "/");

	const root: TreeNode[] = [];

	for (const rawPath of paths.sort()) {
		const parts = rawPath.split("/").filter(Boolean);
		let currentLevel = root;

		parts.forEach((part, i) => {
			const isLeaf = i === parts.length - 1;
			const builtPath = "/" + parts.slice(0, i + 1).join("/");
			// Match by canonical route path, NOT by display name: the display
			// name comes from nameMap and may differ from the raw URL segment
			// (accents restored, e.g. "Règles" vs "Regles"). Matching on name
			// meant every file after the first one in a folder failed to find
			// the existing folder node and created a duplicate instead.
			const existing = currentLevel.find((n) => n.path === builtPath);

			if (existing) {
				if (!isLeaf && !existing.children) existing.children = [];
				currentLevel = existing.children ?? [];
			} else {
				// Use the original vault name from nameMap when available —
				// covers both leaf pages AND folders, so accented/original
				// names ("Règles") show up instead of the sanitized route
				// segment ("Regles").
				const displayName = nameMap[builtPath] ?? part;

				const node: TreeNode = {
					name: displayName,
					path: isLeaf ? builtPath + "/" : builtPath,
					depth: i + 1,
					children: isLeaf ? undefined : [],
				};
				currentLevel.push(node);
				currentLevel = node.children ?? [];
			}
		});
	}

	sortTree(root);
	return root;
}

/** Folders first (alphabetically), then files (alphabetically) — at every
 * level, not just the root. Insertion order out of the loop above just
 * follows a single global string sort of full route paths, which doesn't
 * group folders and files the way a real file explorer does. */
function sortTree(nodes: TreeNode[]): void {
	nodes.sort((a, b) => {
		const aIsFolder = a.children !== undefined ? 0 : 1;
		const bIsFolder = b.children !== undefined ? 0 : 1;
		if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
		return a.name.localeCompare(b.name);
	});
	for (const n of nodes) {
		if (n.children) sortTree(n.children);
	}
}

export const siteTree: TreeNode[] = buildTree();

export function flattenTree(nodes: TreeNode[]): TreeNode[] {
	const result: TreeNode[] = [];
	for (const node of nodes) {
		if (!node.children) result.push(node);
		else result.push(...flattenTree(node.children));
	}
	return result;
}
