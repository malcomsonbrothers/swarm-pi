#!/usr/bin/env node

import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/coding-agent");
const defaultDistDir = join(packageDir, "dist");

/** Remove generated coding-agent output without touching the legacy live bundle. */
export function cleanCodingAgentDist(distDir = defaultDistDir) {
	if (!existsSync(distDir)) return;
	for (const entry of readdirSync(distDir, { withFileTypes: true })) {
		if (entry.name === "bundle") continue;
		rmSync(join(distDir, entry.name), { force: true, recursive: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	cleanCodingAgentDist();
}
