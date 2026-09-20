#!/usr/bin/env node

import { accessSync, constants, lstatSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultCurrentCli = resolve(repoRoot, "packages/coding-agent/dist/current/cli.js");

/**
 * Atomically install the swarm launcher by renaming a temporary symlink over the
 * owner's target. Roll back by running this script with the target bin path after
 * pointing dist/current at a retained dist/bundles/<stamp>-<pid>/cli.js; restart
 * the daemon after changing either symlink. This script never deletes bundles.
 */
export function linkSwarmPi(targetBinPath, currentCliPath = defaultCurrentCli) {
	const target = resolve(targetBinPath);
	const current = resolve(currentCliPath);
	const currentStat = lstatSync(current);
	if (!currentStat.isFile()) {
		throw new Error(`${current} is not a regular executable file`);
	}
	try {
		accessSync(current, constants.X_OK);
	} catch {
		throw new Error(`${current} is not a regular executable file`);
	}
	const currentUserId = process.getuid?.();
	if (currentUserId !== undefined && currentStat.uid === currentUserId && (currentStat.mode & 0o100) === 0) {
		throw new Error(`${current} is not a regular executable file`);
	}

	const oldResolution = resolveExisting(target);
	const temporary = resolve(dirname(target), `.${basename(target)}.swap-${process.pid}`);
	rmSync(temporary, { force: true, recursive: true });
	try {
		symlinkSync(current, temporary);
		renameSync(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true, recursive: true });
		throw error;
	}

	const newResolution = resolveExisting(target);
	console.log(`old resolution: ${oldResolution}`);
	console.log(`new resolution: ${newResolution}`);
	return { oldResolution, newResolution };
}

function resolveExisting(path) {
	try {
		return realpathSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return "<missing>";
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [targetBinPath, ...extra] = process.argv.slice(2);
	if (!targetBinPath || extra.length > 0) {
		console.error("Usage: scripts/link-swarm-pi.mjs <target-bin-path>");
		process.exitCode = 2;
	} else {
		try {
			linkSwarmPi(targetBinPath);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
