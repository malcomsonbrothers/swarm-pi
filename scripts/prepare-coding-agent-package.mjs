#!/usr/bin/env node

import { cpSync, lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/coding-agent");
const defaultDistDir = join(packageDir, "dist");
const backupName = ".current-pack-target";

/** Materialize the current symlink because npm pack does not preserve symlinks. */
export function prepareCodingAgentPackage(distDir = defaultDistDir) {
	const current = join(distDir, "current");
	const backup = join(distDir, backupName);
	let currentStat;
	try {
		currentStat = lstatSync(current);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
	if (!currentStat.isSymbolicLink()) return false;

	rmSync(backup, { force: true, recursive: true });
	const target = realpathSync(current);
	renameSync(current, backup);
	try {
		cpSync(target, current, { recursive: true, dereference: true });
	} catch (error) {
		rmSync(current, { force: true, recursive: true });
		renameSync(backup, current);
		throw error;
	}
	return true;
}

/** Restore the stable current symlink after npm pack or npm publish. */
export function restoreCodingAgentPackage(distDir = defaultDistDir) {
	const current = join(distDir, "current");
	const backup = join(distDir, backupName);
	let backupStat;
	try {
		backupStat = lstatSync(backup);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
	if (!backupStat.isSymbolicLink()) throw new Error(`${backup} is not the saved current symlink`);

	rmSync(current, { force: true, recursive: true });
	renameSync(backup, current);
	return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const action = process.argv[2];
	if (action === "prepare") prepareCodingAgentPackage();
	else if (action === "restore") restoreCodingAgentPackage();
	else throw new Error("Usage: scripts/prepare-coding-agent-package.mjs <prepare|restore>");
}
