import { describe, expect, it } from "vitest";
import { streamSimple as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import type { Context, FetchFunction, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

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

const rateLimitFrame = {
	type: "codex.rate_limits",
	plan_type: "pro",
	rate_limits: {
		allowed: true,
		limit_reached: false,
		primary: { used_percent: 48, window_minutes: 10080, reset_after_seconds: 340319, reset_at: 1789807127 },
		secondary: null,
	},
	credits: { has_credits: false, unlimited: false, balance: "0" },
	promo: null,
};

const completed = {
	type: "response.completed",
	sequence_number: 9,
	response: {
		id: "resp_rate_limits",
		status: "completed",
		output: [],
		usage: {
			input_tokens: 1821,
			input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 1826,
		},
	},
};

function sseBody(events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function sseFetch(events: unknown[], headers: Record<string, string>): FetchFunction {
	return async () =>
		new Response(sseBody(events), {
			status: 200,
			headers: { "content-type": "text/event-stream", ...headers },
		});
}

async function run(events: unknown[], headers: Record<string, string>) {
	return streamOpenAICodexResponses(createModel(), context, {
		apiKey,
		fetch: sseFetch(events, headers),
		transport: "sse",
		maxRetries: 0,
	}).result();
}

describe("OpenAI Codex rate-limit capture", () => {
	it("flattens the codex.rate_limits frame into providerExtra and keeps the modelled usage", async () => {
		const output = await run([rateLimitFrame, completed], {});

		expect(output.stopReason).toBe("stop");
		expect(output.usage.providerExtra).toEqual({
			codex_primary_used_percent: 48,
			codex_primary_window_minutes: 10080,
			codex_primary_reset_after_seconds: 340319,
			codex_primary_reset_at: 1789807127,
			codex_credits_balance: 0,
		});
		expect(output.usage).toMatchObject({ input: 1821, output: 5, cacheRead: 0, reasoning: 0, totalTokens: 1826 });
	});

	it("reads numeric x-codex-* response headers under the same keys and skips opaque ones", async () => {
		const output = await run([completed], {
			"x-codex-primary-used-percent": "48",
			"x-codex-primary-reset-at": "1789807127",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-credits-balance": "0",
			"x-codex-credits-has-credits": "False",
			"x-codex-active-limit": "premium",
			"x-codex-turn-state": "123456",
			"x-codex-bengalfox-primary-used-percent": "0",
		});

		expect(output.usage.providerExtra).toEqual({
			codex_primary_used_percent: 48,
			codex_primary_reset_at: 1789807127,
			codex_primary_window_minutes: 10080,
			codex_credits_balance: 0,
			codex_bengalfox_primary_used_percent: 0,
		});
	});

	it("lets the frame refine the headers and keeps unmodelled usage members beside them", async () => {
		const withBudget = {
			...completed,
			response: { ...completed.response, usage: { ...completed.response.usage, codex_rollout_budget_units: 2.5 } },
		};
		const output = await run([rateLimitFrame, withBudget], { "x-codex-primary-used-percent": "47" });

		expect(output.usage.providerExtra).toMatchObject({
			codex_primary_used_percent: 48,
			codex_rollout_budget_units: 2.5,
		});
	});

	it("leaves providerExtra undefined when neither frame nor headers carry a reading", async () => {
		const output = await run([completed], {});

		expect(output.usage.providerExtra).toBeUndefined();
	});
});
