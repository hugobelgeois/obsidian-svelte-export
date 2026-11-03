import * as path from "path";
import { describe, expect, it } from "vitest";
import { resolveDestinationPath, toVaultRelativePath } from "../src/obsidianUtil";

describe("toVaultRelativePath", () => {
	it("returns the path inside the vault, /-separated", () => {
		expect(toVaultRelativePath("C:\\Vault", "C:\\Vault\\Images\\a.png")).toBe(
			"Images/a.png",
		);
	});

	it("ignores case, like Windows paths do", () => {
		expect(toVaultRelativePath("C:\\Vault", "c:\\vault\\a.js")).toBe("a.js");
	});

	it("accepts a vault path with a trailing separator", () => {
		expect(toVaultRelativePath("/home/me/vault/", "/home/me/vault/a.js")).toBe(
			"a.js",
		);
	});

	it("rejects files outside the vault, even with a shared prefix", () => {
		expect(toVaultRelativePath("C:\\Vault", "C:\\Other\\a.png")).toBeNull();
		expect(toVaultRelativePath("C:\\Vault", "C:\\Vault2\\a.png")).toBeNull();
	});
});

describe("resolveDestinationPath", () => {
	const vault = path.resolve("vault");

	it("keeps an absolute destination as-is", () => {
		const absolute = path.resolve("elsewhere", "site");
		expect(resolveDestinationPath(vault, absolute)).toBe(absolute);
	});

	it("resolves a relative destination against the vault", () => {
		expect(resolveDestinationPath(vault, "../site")).toBe(
			path.resolve(vault, "../site"),
		);
	});

	it("understands backslashes saved from Windows", () => {
		expect(resolveDestinationPath(vault, "..\\site")).toBe(
			path.resolve(vault, "../site"),
		);
	});
});
