import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkSwarmPi } from "./link-swarm-pi.mjs";

test("replaces a launcher target with one atomic symlink rename", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-link-swarm-"));
	try {
		const currentCli = join(root, "current", "cli.js");
		const target = join(root, "bin", "swarm-pi");
		await mkdir(join(root, "bin"), { recursive: true });
		await mkdir(join(root, "current"), { recursive: true });
		await writeFile(currentCli, "new cli");
		await chmod(currentCli, 0o755);
		await symlink("missing-old-cli", target);

		const result = linkSwarmPi(target, currentCli);

		assert.notEqual(result.oldResolution, result.newResolution);
		assert.equal(lstatSync(target).isSymbolicLink(), true);
		assert.equal(realpathSync(target), realpathSync(currentCli));
		assert.equal(await readFile(target, "utf8"), "new cli");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses a missing or non-executable current launcher", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-link-swarm-"));
	try {
		const target = join(root, "bin", "swarm-pi");
		const currentCli = join(root, "current", "cli.js");
		await mkdir(join(root, "bin"), { recursive: true });
		await mkdir(join(root, "current"), { recursive: true });
		await writeFile(currentCli, "not executable");

		assert.throws(() => linkSwarmPi(target, currentCli), /regular executable file/i);
		await chmod(currentCli, 0o401);
		assert.throws(() => linkSwarmPi(target, currentCli), /regular executable file/i);
		await rm(currentCli);
		await mkdir(currentCli);
		await chmod(currentCli, 0o755);
		assert.throws(() => linkSwarmPi(target, currentCli), /regular executable file/i);
		await rm(currentCli, { recursive: true });
		assert.throws(() => linkSwarmPi(target, currentCli), /ENOENT|no such file/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
