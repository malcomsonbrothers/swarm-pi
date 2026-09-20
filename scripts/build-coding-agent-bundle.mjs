#!/usr/bin/env node

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { publishBundle } from "./bundle-swap.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundlesDir = join(codingAgentDistDir, "bundles");
const currentBundleDir = join(codingAgentDistDir, "current");
// dist/bundle is a legacy live directory and is intentionally never touched. The
// new bundle is built completely in dist/bundles staging, then published under a
// new versioned directory through the stable dist/current symlink. Sessions that
// already imported the old bundle keep resolving its retained lazy chunks.
const stagingDir = join(bundlesDir, `.staging-${process.pid}`);

function copyCarriedOverChunks(previousBundleDir, nextBundleDir) {
	const previousChunks = join(previousBundleDir, "chunks");
	const nextChunks = join(nextBundleDir, "chunks");
	if (!existsSync(previousChunks)) return 0;

	mkdirSync(nextChunks, { recursive: true });
	const present = new Set(readdirSync(nextChunks, { withFileTypes: true }).map((entry) => entry.name));
	let carried = 0;
	for (const entry of readdirSync(previousChunks, { withFileTypes: true })) {
		if (!entry.isFile() || present.has(entry.name)) continue;
		copyFileSync(join(previousChunks, entry.name), join(nextChunks, entry.name));
		carried++;
	}
	return carried;
}

const banner = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set([
	"@earendil-works/chord",
	"@earendil-works/chord/bundler",
	"@earendil-works/chord/context",
	"@earendil-works/chord/delta",
	"@earendil-works/chord/node",
	"@silvia-odwyer/photon-node",
	"jiti",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional native proxy authentication. Its caller reports an install hint when absent.
	"kerberos",
	// Optional debug output coloring.
	"supports-color",
]);

const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: repoRoot,
			}),
		);
	},
};

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { PI_BUNDLED_NODE: "true" },
		external: ["@earendil-works/chord", "@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		// The source uses jiti/static so Bun embeds its Babel transform. The Node
		// package replaces it with a synchronous lazy require so jiti loads only
		// when importing an extension; Babel remains deferred until a cache miss
		// needs transformation.
		plugins: [lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. Release builds must resolve the same package entries as
		// an installed npm package.
		tsconfigRaw: { compilerOptions: {} },
	};
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
	join(aiDistDir, "auth", "oauth", "anthropic.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

rmSync(stagingDir, { force: true, recursive: true });
mkdirSync(stagingDir, { recursive: true });

let carriedOverChunks = 0;
try {
	const mainResult = await build({
		...commonBuildOptions(),
		entryNames: "[name]",
		entryPoints: {
			"cli-runtime": join(codingAgentDistDir, "cli.js"),
			index: join(codingAgentDistDir, "index.js"),
			"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
		},
		outdir: stagingDir,
		chunkNames: "chunks/[name]-[hash]",
		splitting: true,
	});

	const bedrockLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/api/bedrock-converse-stream.lazy.js");
	const oauthLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/auth/oauth/load.js");
	const imageResizeOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/utils/image-resize.js");
	if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
		throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
	}

	// These implementations are reached through variable-specifier imports or a
	// worker URL, so the main bundle cannot follow them. Emit one self-contained
	// file per implementation beside the code that resolves it.
	const lazyResult = await build({
		...commonBuildOptions(),
		entryNames: "[name]",
		entryPoints: {
			anthropic: join(aiDistDir, "auth", "oauth", "anthropic.js"),
			"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
			"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
			"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
			"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
			meta: join(aiDistDir, "auth", "oauth", "meta.js"),
			"openai-codex": join(aiDistDir, "auth", "oauth", "openai-codex.js"),
			openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
			radius: join(aiDistDir, "auth", "oauth", "radius.js"),
			xai: join(aiDistDir, "auth", "oauth", "xai.js"),
		},
		outdir: dirname(bedrockLoaderOutput),
		splitting: false,
	});

	const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
	if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
		throw new Error("Image resize implementation and worker were emitted into different directories");
	}

	validateExternalImports([mainResult.metafile, lazyResult.metafile]);

	// Carry over the chunks this build did not re-emit, so a session that lazy
	// imports one by its old hashed name still resolves it after the swap.
	carriedOverChunks = copyCarriedOverChunks(currentBundleDir, stagingDir);

	// The launcher and executable modes are part of staging too. The stable
	// symlink is flipped only after every file the live command can reach exists.
	const cliLauncher = `#!/usr/bin/env node
import { createRequire, enableCompileCache } from "node:module";

enableCompileCache();
createRequire(import.meta.url)("./cli-runtime.js");
`;
	writeFileSync(join(stagingDir, "cli.js"), cliLauncher);
	chmodSync(join(stagingDir, "cli.js"), 0o755);
	chmodSync(join(stagingDir, "rpc-entry.js"), 0o755);
	publishBundle(currentBundleDir, stagingDir, bundlesDir);

	const files =
		new Set([...Object.keys(mainResult.metafile.outputs), ...Object.keys(lazyResult.metafile.outputs)]).size + 1;
	const mib = (outputBytes([mainResult.metafile, lazyResult.metafile]) + cliLauncher.length) / (1024 * 1024);
	const carried = carriedOverChunks > 0 ? `, ${carriedOverChunks} chunk(s) carried over` : "";
	console.log(`Built ${relative(repoRoot, currentBundleDir)} (${files} files, ${mib.toFixed(1)} MiB${carried})`);
} finally {
	// Whatever happened before publication, leave no staging directory beside the bundle.
	rmSync(stagingDir, { force: true, recursive: true });
}
