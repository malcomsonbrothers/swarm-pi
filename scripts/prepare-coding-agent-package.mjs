#!/usr/bin/env node

import { cpSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const defaultPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/coding-agent");

function isExcludedPackagePath(packageDir, source) {
	const relativePath = relative(packageDir, source).replaceAll("\\", "/");
	return (
		relativePath === "node_modules" ||
		relativePath.startsWith("node_modules/") ||
		relativePath === "dist/bundles" ||
		relativePath.startsWith("dist/bundles/")
	);
}

/**
 * Copy the package into a temporary directory with dist/current dereferenced there.
 * The live package directory, including its current symlink, is never modified.
 */
export function copyCodingAgentPackageForPack(packageDir = defaultPackageDir) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-coding-agent-pack-"));
	const packageCopy = join(temporaryRoot, basename(packageDir));
	try {
		const current = join(packageDir, "dist", "current");
		const currentStat = lstatSync(current);
		if (!currentStat.isSymbolicLink()) {
			throw new Error(`${current} must be a symlink before packaging`);
		}
		cpSync(packageDir, packageCopy, {
			recursive: true,
			dereference: true,
			filter: (source) => !isExcludedPackagePath(packageDir, source),
		});
		return packageCopy;
	} catch (error) {
		rmSync(temporaryRoot, { force: true, recursive: true });
		throw error;
	}
}

/** Remove a temporary package copy returned by copyCodingAgentPackageForPack(). */
export function removeCodingAgentPackageCopy(packageCopy) {
	rmSync(dirname(packageCopy), { force: true, recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, packageDir] = process.argv.slice(2);
	if (action !== "copy" || !packageDir) {
		throw new Error("Usage: scripts/prepare-coding-agent-package.mjs copy <package-dir>");
	}
	console.log(copyCodingAgentPackageForPack(resolve(packageDir)));
}
