import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	name: string;
	bin: { pi: string };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./client": { source: string };
		"./experimental/plugin": { source: string };
		"./rpc-entry": { import: string };
	};
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.bin.pi).toBe("dist/current/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/current/rpc-entry.js");
	});

	test("resolves bin and rpc-entry through the current symlink", () => {
		const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
		const binPath = realpathSync(join(packageDirectory, packageJson.bin.pi));
		const rpcPath = fileURLToPath(import.meta.resolve(`${packageJson.name}/rpc-entry`));
		expect(binPath).toBe(realpathSync(join(packageDirectory, "dist/current/cli.js")));
		expect(realpathSync(rpcPath)).toBe(realpathSync(join(packageDirectory, "dist/current/rpc-entry.js")));
	});

	// Regression for #9132: internal experimental entrypoints must not be published runtime exports.
	test("keeps experimental exports source-only", () => {
		expect(packageJson.exports["./client"]).toEqual({ source: "./src/client/index.ts" });
		expect(packageJson.exports["./experimental/plugin"]).toEqual({ source: "./src/experimental/plugin.ts" });
	});
});
