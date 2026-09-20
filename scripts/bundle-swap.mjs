import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const BUNDLE_RETENTION_COUNT = 3;
const BUNDLE_MINIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VERSIONED_BUNDLE_NAME = /^\d+-\d+$/;

/**
 * Atomically publish a fully-built bundle under dist/bundles and dist/current.
 *
 * The old dist/bundle directory is intentionally unrelated and is never moved or
 * replaced. Roll back by atomically replacing current with a temporary symlink to
 * a retained versioned bundle, then restart the daemon. The owner can similarly
 * roll back the launcher symlink with scripts/link-swarm-pi.mjs.
 */
export function publishBundle(currentLink, stagingDir, bundlesDir) {
	mkdirSync(bundlesDir, { recursive: true });
	let existingCurrent;
	try {
		existingCurrent = lstatSync(currentLink);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (existingCurrent && !existingCurrent.isSymbolicLink()) {
		throw new Error(`Cannot atomically replace ${currentLink}: it must be a symlink or absent`);
	}

	const versionedDir = join(bundlesDir, `${Date.now()}-${process.pid}`);
	const swapLink = join(dirname(currentLink), `.current.swap-${process.pid}`);
	try {
		rmSync(swapLink, { force: true, recursive: true });
		renameSync(stagingDir, versionedDir);
		const target = process.platform === "win32" ? versionedDir : relative(dirname(currentLink), versionedDir);
		symlinkSync(target, swapLink, process.platform === "win32" ? "junction" : "dir");
		renameSync(swapLink, currentLink);
	} catch (error) {
		rmSync(swapLink, { force: true, recursive: true });
		throw error;
	}

	pruneVersionedBundles(bundlesDir, versionedDir);
	return versionedDir;
}

function pruneVersionedBundles(bundlesDir, currentBundleDir) {
	const bundles = readdirSync(bundlesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && VERSIONED_BUNDLE_NAME.test(entry.name))
		.map((entry) => {
			const path = join(bundlesDir, entry.name);
			return { path, mtimeMs: statSync(path).mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const retained = new Set(bundles.slice(0, BUNDLE_RETENTION_COUNT).map((bundle) => bundle.path));
	retained.add(currentBundleDir);
	const cutoff = Date.now() - BUNDLE_MINIMUM_AGE_MS;

	for (const bundle of bundles) {
		if (retained.has(bundle.path) || bundle.mtimeMs > cutoff) continue;
		rmSync(bundle.path, { force: true, recursive: true });
	}
}

export const bundleRetention = {
	count: BUNDLE_RETENTION_COUNT,
	minimumAgeMs: BUNDLE_MINIMUM_AGE_MS,
};
