import { describe, expect, it } from "vitest";
import { streamSimple as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// The 2026-09-17 incident: Codex answered a burst with HTTP 429 and a Retry-After of
// a few seconds, and the transport ended the turn on the first one and called it an
// exhausted subscription. These tests pin the retry loop and the wording apart.

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

const completed = {
	type: "response.completed",
	sequence_number: 9,
	response: {
		id: "resp_retries",
		status: "completed",
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

function okResponse(): Response {
	return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function rateLimited(body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, { status: 429, headers: { "content-type": "application/json", ...headers } });
}

/** Answers with each queued response in turn, repeating the last, and counts the calls. */
function scriptedFetch(responses: (() => Response)[]): { fetch: FetchFunction; calls: () => number } {
	let calls = 0;
	const fetch: FetchFunction = async () => {
		const next = responses[Math.min(calls, responses.length - 1)];
		calls++;
		return next();
	};
	return { fetch, calls: () => calls };
}

function run(fetch: FetchFunction, options: Record<string, unknown> = {}) {
	return streamOpenAICodexResponses(createModel(), context, {
		apiKey,
		fetch,
		transport: "sse",
		...options,
	}).result();
}

describe("OpenAI Codex retries", () => {
	it("retries a 429 after the Retry-After delay and reports the attempt in providerExtra", async () => {
		const scripted = scriptedFetch([
			() => rateLimited(JSON.stringify({ detail: "Rate limit exceeded" }), { "retry-after": "1" }),
			() => okResponse(),
		]);

		const started = Date.now();
		const output = await run(scripted.fetch);

		expect(output.stopReason).toBe("stop");
		expect(scripted.calls()).toBe(2);
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		expect(output.usage.providerExtra).toMatchObject({
			codex_retry_attempts: 1,
			codex_retry_after_seconds: 1,
		});
	});

	it("gives up after five 429s with the rate-limit text, not the usage-limit text", async () => {
		const scripted = scriptedFetch([
			() =>
				rateLimited(JSON.stringify({ error: { type: "rate_limit_exceeded", message: "Rate limit exceeded" } }), {
					"retry-after": "0",
				}),
		]);

		const output = await run(scripted.fetch);

		expect(scripted.calls()).toBe(5);
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("Codex rate limit: Rate limit exceeded; retried 4 times");
		expect(output.errorMessage).not.toContain("usage limit");
	});

	it("fails at once on a usage_limit_reached body with the usage-limit text", async () => {
		const scripted = scriptedFetch([
			() =>
				rateLimited(
					JSON.stringify({
						error: {
							type: "usage_limit_reached",
							message: "You have hit your usage limit.",
							plan_type: "Pro",
							resets_at: Math.floor(Date.now() / 1000) + 3600,
						},
					}),
					{ "retry-after": "0" },
				),
		]);

		const output = await run(scripted.fetch);

		expect(scripted.calls()).toBe(1);
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("You have hit your ChatGPT usage limit (pro plan). Try again in ~60 min.");
	});

	it("rejects promptly when the signal aborts during the retry wait", async () => {
		const scripted = scriptedFetch([
			() => rateLimited(JSON.stringify({ detail: "Rate limit exceeded" }), { "retry-after": "30" }),
		]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);

		const started = Date.now();
		const output = await run(scripted.fetch, { signal: controller.signal });

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(scripted.calls()).toBe(1);
		expect(output.stopReason).toBe("aborted");
		expect(output.errorMessage).toContain("Request was aborted");
	});
});
