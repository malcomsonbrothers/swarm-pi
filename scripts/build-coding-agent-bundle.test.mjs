import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishBundle } from "./bundle-swap.mjs";
import { cleanCodingAgentDist } from "./clean-coding-agent-dist.mjs";
import {
	assertCodingAgentPackageExecutable,
	copyCodingAgentPackageForPack,
	removeCodingAgentPackageCopy,
} from "./prepare-coding-agent-package.mjs";

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

test("guards direct npm packing and publishing with an executable current launcher", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-package-guard-"));
	try {
		const packageDir = join(root, "package");
		const bundleDir = join(packageDir, "dist", "bundles", "123-1");
		const current = join(packageDir, "dist", "current");
		await mkdir(bundleDir, { recursive: true });
		await symlink("bundles/123-1", current, "dir");
		await writeFile(join(bundleDir, "cli.js"), "launcher");
		await chmod(join(bundleDir, "cli.js"), 0o755);
		assert.doesNotThrow(() => assertCodingAgentPackageExecutable(packageDir));

		await chmod(join(bundleDir, "cli.js"), 0o644);
		assert.throws(
			() => assertCodingAgentPackageExecutable(packageDir),
			/Run "npm run build:offline" before packing or publishing/,
		);
		await rm(join(bundleDir, "cli.js"));
		await mkdir(join(bundleDir, "cli.js"));
		assert.throws(() => assertCodingAgentPackageExecutable(packageDir), /regular executable file/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("packs a temporary copy while a second process sees a complete live symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bundle-pack-"));
	let packageCopy;
	let poller;
	try {
		const packageDir = join(root, "package");
		const bundles = join(packageDir, "dist", "bundles", "123-1");
		const current = join(packageDir, "dist", "current");
		await mkdir(bundles, { recursive: true });
		await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "test-package", files: ["dist"] }));
		await writeFile(join(bundles, "cli.js"), "bundle launcher".repeat(1024 * 1024));
		await symlink("bundles/123-1", current, "dir");

		const pollerScript = `
			const fs = require("node:fs");
			const path = require("node:path");
			const current = process.argv[1];
			let failed = false;
			const check = () => {
				try {
					if (!fs.lstatSync(current).isSymbolicLink()) throw new Error("current is not a symlink");
					if (!fs.statSync(path.join(fs.realpathSync(current), "cli.js")).isFile()) throw new Error("cli.js is missing");
				} catch (error) {
					failed = true;
					process.stderr.write(error.message + "\\n");
					process.exit(1);
				}
			};
			check();
			process.stdout.write("ready\\n");
			setInterval(check, 1);
			process.on("SIGTERM", () => process.exit(failed ? 1 : 0));
		`;
		poller = spawn(process.execPath, ["-e", pollerScript, current], { stdio: ["ignore", "pipe", "pipe"] });
		await new Promise((resolve, reject) => {
			poller.stdout.setEncoding("utf8");
			poller.stdout.on("data", (data) => data.includes("ready") && resolve());
			poller.once("error", reject);
			poller.once("exit", (code) => reject(new Error(`poller exited before ready: ${code}`)));
		});

		packageCopy = copyCodingAgentPackageForPack(packageDir);
		assert.equal(lstatSync(current).isSymbolicLink(), true);
		assert.equal(lstatSync(join(packageCopy, "dist", "current")).isDirectory(), true);
		assert.equal(await readFile(join(packageCopy, "dist", "current", "cli.js"), "utf8"), "bundle launcher".repeat(1024 * 1024));
	} finally {
		if (poller) {
			if (poller.exitCode === null) {
				poller.kill("SIGTERM");
				await new Promise((resolve) => poller.once("exit", resolve));
			}
			assert.equal(poller.exitCode, 0);
		}
		if (packageCopy) removeCodingAgentPackageCopy(packageCopy);
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
