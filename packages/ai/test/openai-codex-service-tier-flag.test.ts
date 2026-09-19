import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CODEX_PRIORITY_TIER_CONSENT,
	CODEX_SERVICE_TIER_FILE_ENV,
	codexPriorityTierWarning,
	codexServiceTierFlagFilePath,
	codexServiceTierFromFlagFile,
	resetCodexPriorityTierWarning,
	streamSimple as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

let homeDir: string;
let runDir: string;
const noWarn = () => {};

function homeFlagFile(contents: string): void {
	const agentDir = join(homeDir, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "codex-service-tier"), contents);
}

function runFlagFilePath(): string {
	return join(runDir, "codex-service-tier");
}

function runFlagFile(contents: string): string {
	writeFileSync(runFlagFilePath(), contents);
	return runFlagFilePath();
}

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), "pi-codex-tier-home-"));
	runDir = mkdtempSync(join(tmpdir(), "pi-codex-tier-run-"));
	resetCodexPriorityTierWarning();
});

afterEach(() => {
	rmSync(homeDir, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
	delete process.env[CODEX_SERVICE_TIER_FILE_ENV];
	resetCodexPriorityTierWarning();
});

describe("codexServiceTierFromFlagFile", () => {
	it("returns no tier when the file is missing", () => {
		expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn: noWarn })).toBeUndefined();
	});

	it("accepts the consent sentence for the priority tier", () => {
		homeFlagFile(`${CODEX_PRIORITY_TIER_CONSENT}\n`);
		expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn: noWarn })).toBe("priority");
	});

	it("accepts the word flex", () => {
		homeFlagFile("  flex \n");
		expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn: noWarn })).toBe("flex");
	});

	it("rejects the bare word priority and any other text", () => {
		for (const contents of [
			"priority",
			"Priority",
			"",
			"I accept that the priority tier uses the subscription more than twice as fast please",
			"i accept that the priority tier uses the subscription more than twice as fast",
			"flex priority",
		]) {
			homeFlagFile(contents);
			expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn: noWarn })).toBeUndefined();
		}
	});

	it("warns once per process when priority is applied, naming the file", () => {
		homeFlagFile(CODEX_PRIORITY_TIER_CONSENT);
		const warnings: string[] = [];
		const warn = (message: string) => warnings.push(message);

		expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn })).toBe("priority");
		expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn })).toBe("priority");
		expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn })).toBe("priority");

		expect(warnings).toEqual([codexPriorityTierWarning(join(homeDir, ".pi", "agent", "codex-service-tier"))]);
		expect(warnings[0]).toContain("more than twice as fast");
	});

	it("does not warn for the flex tier", () => {
		homeFlagFile("flex");
		const warnings: string[] = [];
		expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn: (m) => warnings.push(m) })).toBe("flex");
		expect(warnings).toEqual([]);
	});
});

describe("PI_CODEX_SERVICE_TIER_FILE", () => {
	it("makes the named file the only switch consulted", () => {
		homeFlagFile(CODEX_PRIORITY_TIER_CONSENT);
		const env = { [CODEX_SERVICE_TIER_FILE_ENV]: runFlagFilePath() };

		expect(codexServiceTierFlagFilePath({ homeDir, env })).toBe(runFlagFilePath());
		// The per-run file does not exist yet: the home file is ignored, not a fallback.
		expect(codexServiceTierFromFlagFile({ homeDir, env, warn: noWarn })).toBeUndefined();

		runFlagFile("flex");
		expect(codexServiceTierFromFlagFile({ homeDir, env, warn: noWarn })).toBe("flex");

		runFlagFile(`${CODEX_PRIORITY_TIER_CONSENT}\n`);
		expect(codexServiceTierFromFlagFile({ homeDir, env, warn: noWarn })).toBe("priority");

		// Switched off mid-session by removing the file, and read again per request.
		rmSync(runFlagFilePath());
		expect(codexServiceTierFromFlagFile({ homeDir, env, warn: noWarn })).toBeUndefined();
	});

	it("falls back to the home file when the variable is unset or empty", () => {
		homeFlagFile("flex");
		expect(codexServiceTierFromFlagFile({ homeDir, env: {}, warn: noWarn })).toBe("flex");
		expect(
			codexServiceTierFromFlagFile({ homeDir, env: { [CODEX_SERVICE_TIER_FILE_ENV]: "  " }, warn: noWarn }),
		).toBe("flex");
	});

	it("names the per-run file in the warning written to stderr", () => {
		runFlagFile(CODEX_PRIORITY_TIER_CONSENT);
		process.env[CODEX_SERVICE_TIER_FILE_ENV] = runFlagFilePath();
		const written: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(codexServiceTierFromFlagFile({ homeDir })).toBe("priority");
			expect(codexServiceTierFromFlagFile({ homeDir })).toBe("priority");
		} finally {
			process.stderr.write = realWrite;
		}

		expect(written).toEqual([`${codexPriorityTierWarning(runFlagFilePath())}\n`]);
	});
});

// A turn's own record of the tier it asked for, taken from the request and never
// from the response. Runs against a scripted fetch: no provider is contacted.

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

const apiKey = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`;

function createModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
}

/** One completed SSE response that claims the default tier, whatever was asked for. */
function scriptedFetch(): { fetch: FetchFunction } {
	const fetch: FetchFunction = async () => {
		const completed = {
			type: "response.completed",
			sequence_number: 9,
			response: {
				id: "resp_tier",
				status: "completed",
				service_tier: "default",
				output: [],
				usage: {
					input_tokens: 10,
					input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
					output_tokens: 2,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 12,
				},
			},
		};
		return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { fetch };
}

/** Runs one turn against the scripted fetch and reports the tier the request carried. */
async function runTurn(): Promise<{ requestedTier: unknown; providerExtra: Record<string, unknown> }> {
	let requestedTier: unknown;
	const output = await streamOpenAICodexResponses(createModel(), context, {
		apiKey,
		fetch: scriptedFetch().fetch,
		transport: "sse",
		onPayload: (payload) => {
			requestedTier = (payload as { service_tier?: unknown }).service_tier;
			return undefined;
		},
	}).result();
	return { requestedTier, providerExtra: (output.usage.providerExtra ?? {}) as Record<string, unknown> };
}

describe("codex_service_tier_requested", () => {
	it("records the tier the flag file asked for on the turn's usage", async () => {
		runFlagFile(CODEX_PRIORITY_TIER_CONSENT);
		process.env[CODEX_SERVICE_TIER_FILE_ENV] = runFlagFilePath();

		const { requestedTier, providerExtra } = await runTurn();

		expect(requestedTier).toBe("priority");
		// The response claimed "default"; the record keeps what pi asked for.
		expect(providerExtra).toMatchObject({ codex_service_tier_requested: "priority" });
	});

	it("is absent when no tier was requested", async () => {
		process.env[CODEX_SERVICE_TIER_FILE_ENV] = runFlagFilePath();

		const { requestedTier, providerExtra } = await runTurn();

		expect(requestedTier).toBeUndefined();
		expect(providerExtra).not.toHaveProperty("codex_service_tier_requested");
	});
});
