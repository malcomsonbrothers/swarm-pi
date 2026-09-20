import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { swapBundle } from "./bundle-swap.mjs";

test("publishes a complete bundle by flipping the stable symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bundle-swap-"));
	try {
		const bundle = join(root, "bundle");
		const oldBundle = join(root, "bundle.old");
		const staging = join(root, "bundle.staging");
		await mkdir(join(oldBundle, "chunks"), { recursive: true });
		await writeFile(join(oldBundle, "cli.js"), "old launcher");
		await symlink("bundle.old", bundle, "dir");
		await mkdir(join(staging, "chunks"), { recursive: true });
		await writeFile(join(staging, "cli.js"), "new launcher");
		await writeFile(join(staging, "chunks", "mode.js"), "new mode");

		const published = swapBundle(bundle, staging);

		assert.equal(lstatSync(bundle).isSymbolicLink(), true);
		assert.equal(await readFile(join(bundle, "cli.js"), "utf8"), "new launcher");
		assert.equal(await readFile(join(bundle, "chunks", "mode.js"), "utf8"), "new mode");
		assert.equal(await readFile(join(published, "cli.js"), "utf8"), "new launcher");
		assert.equal(await readFile(join(oldBundle, "cli.js"), "utf8"), "old launcher");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects an old-style bundle directory instead of creating a gap", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bundle-swap-"));
	try {
		const bundle = join(root, "bundle");
		const staging = join(root, "bundle.staging");
		await mkdir(bundle);
		await mkdir(staging);

		assert.throws(
			() => swapBundle(bundle, staging),
			/Cannot atomically replace .* it is a directory.*symlink/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
