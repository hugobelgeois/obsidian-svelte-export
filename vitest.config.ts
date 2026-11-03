import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// The real "obsidian" package only ships type declarations — the
			// API itself exists inside the Obsidian app. Tests get a stand-in.
			obsidian: fileURLToPath(new URL("./tests/obsidianStub.ts", import.meta.url)),
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
