import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishBundle } from "./bundle-swap.mjs";
import { cleanCodingAgentDist } from "./clean-coding-agent-dist.mjs";
import { prepareCodingAgentPackage, restoreCodingAgentPackage } from "./prepare-coding-agent-package.mjs";

test("publishes current atomically without touching the legacy bundle directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bundle-publish-"));
	try {
		const dist = join(root, "dist");
		const bundles = join(dist, "bundles");
		const legacyBundle = join(dist, "bundle");
		const current = join(dist, "current");
		const oldBundle = join(bundles, "1000-1");
		const staging = join(bundles, ".staging");
		await mkdir(join(legacyBundle, "chunks"), { recursive: true });
		await writeFile(join(legacyBundle, "cli.js"), "legacy launcher");
		await mkdir(join(oldBundle, "chunks"), { recursive: true });
		await writeFile(join(oldBundle, "cli.js"), "old launcher");
		await symlink("bundles/1000-1", current, "dir");
		await mkdir(join(staging, "chunks"), { recursive: true });
		await writeFile(join(staging, "cli.js"), "new launcher");
		await writeFile(join(staging, "chunks", "mode.js"), "new mode");

		const published = publishBundle(current, staging, bundles);

		assert.equal(lstatSync(current).isSymbolicLink(), true);
		assert.match(published, /bundles\/\d+-\d+$/);
		assert.equal(await readFile(join(current, "cli.js"), "utf8"), "new launcher");
		assert.equal(await readFile(join(current, "chunks", "mode.js"), "utf8"), "new mode");
		assert.equal(await readFile(join(oldBundle, "cli.js"), "utf8"), "old launcher");
		assert.equal(await readFile(join(legacyBundle, "cli.js"), "utf8"), "legacy launcher");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cleans generated output without touching the legacy bundle directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bundle-clean-"));
	try {
		const dist = join(root, "dist");
		const legacyBundle = join(dist, "bundle");
		await mkdir(join(legacyBundle, "chunks"), { recursive: true });
		await writeFile(join(legacyBundle, "cli.js"), "legacy launcher");
		await mkdir(join(dist, "bundles", "123-1"), { recursive: true });
		await writeFile(join(dist, "index.js"), "generated output");

		cleanCodingAgentDist(dist);

		assert.equal(lstatSync(legacyBundle).isDirectory(), true);
		assert.equal(await readFile(join(legacyBundle, "cli.js"), "utf8"), "legacy launcher");
		assert.equal(lstatSync(join(dist, "bundles"), { throwIfNoEntry: false }), undefined);
		assert.equal(lstatSync(join(dist, "index.js"), { throwIfNoEntry: false }), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("materializes current for npm pack and restores its symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bundle-pack-"));
	try {
		const dist = join(root, "dist");
		const bundles = join(dist, "bundles", "123-1");
		const current = join(dist, "current");
		await mkdir(bundles, { recursive: true });
		await writeFile(join(bundles, "cli.js"), "bundle launcher");
		await symlink("bundles/123-1", current, "dir");

		assert.equal(prepareCodingAgentPackage(dist), true);
		assert.equal(lstatSync(current).isDirectory(), true);
		assert.equal(await readFile(join(current, "cli.js"), "utf8"), "bundle launcher");
		assert.equal(restoreCodingAgentPackage(dist), true);
		assert.equal(lstatSync(current).isSymbolicLink(), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects a real current directory without moving any bundle", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bundle-publish-"));
	try {
		const dist = join(root, "dist");
		const bundles = join(dist, "bundles");
		const current = join(dist, "current");
		const staging = join(bundles, ".staging");
		await mkdir(current, { recursive: true });
		await mkdir(staging, { recursive: true });

		assert.throws(() => publishBundle(current, staging, bundles), /must be a symlink or absent/);
		assert.equal(lstatSync(current).isDirectory(), true);
		assert.equal(lstatSync(staging).isDirectory(), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
