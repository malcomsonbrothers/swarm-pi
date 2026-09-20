import { lstatSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Atomically publish a fully-built bundle through a stable symlink.
 *
 * The old bundle must already be a symlink. A directory cannot be renamed over
 * a non-empty directory on Linux, so the one-time install migration must turn
 * the existing bundle directory into a versioned directory plus this symlink.
 */
export function swapBundle(bundleDir, stagingDir) {
	let existing;
	try {
		existing = lstatSync(bundleDir);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (existing && !existing.isSymbolicLink()) {
		throw new Error(
			`Cannot atomically replace ${bundleDir}: it is a directory. Stop the daemon, move it to a versioned bundle directory, and replace it with a symlink before building.`,
		);
	}

	const parentDir = dirname(bundleDir);
	const nextBundleDir = join(parentDir, `${basename(bundleDir)}.${Date.now()}-${process.pid}`);
	const swapLink = join(parentDir, `${basename(bundleDir)}.swap-${process.pid}`);
	rmSync(swapLink, { force: true, recursive: true });

	renameSync(stagingDir, nextBundleDir);
	try {
		const symlinkType = process.platform === "win32" ? "junction" : "dir";
		const symlinkTarget = symlinkType === "junction" ? nextBundleDir : basename(nextBundleDir);
		symlinkSync(symlinkTarget, swapLink, symlinkType);
		renameSync(swapLink, bundleDir);
	} catch (error) {
		rmSync(swapLink, { force: true, recursive: true });
		throw error;
	}

	return nextBundleDir;
}
