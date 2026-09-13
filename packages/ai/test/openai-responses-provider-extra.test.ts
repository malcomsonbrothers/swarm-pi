import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 0,
	};
}

async function finalize(rawUsage: Record<string, unknown>): Promise<AssistantMessage> {
	const model = createModel();
	const output = createOutput(model);
	async function* events(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.completed",
			sequence_number: 0,
			response: { id: "resp_provider_extra", status: "completed", usage: rawUsage },
		} as unknown as ResponseStreamEvent;
	}
	await processResponsesStream(events(), output, new AssistantMessageEventStream(), model);
	return output;
}

describe("OpenAI Responses providerExtra usage capture", () => {
	it("keeps unmodelled numeric members without changing the ordinary fields", async () => {
		const output = await finalize({
			input_tokens: 20,
			output_tokens: 7,
			total_tokens: 27,
			input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
			output_tokens_details: { reasoning_tokens: 4 },
			codex_rollout_budget_units: 2.5,
		});

		expect(output.usage.providerExtra).toEqual({ codex_rollout_budget_units: 2.5 });
		expect(output.usage).toMatchObject({
			input: 15,
			output: 7,
			cacheRead: 2,
			cacheWrite: 3,
			reasoning: 4,
			totalTokens: 27,
		});
	});

	it("leaves providerExtra undefined for modelled-only usage", async () => {
		const output = await finalize({
			input_tokens: 20,
			output_tokens: 7,
			total_tokens: 27,
			input_tokens_details: { cached_tokens: 2 },
		});

		expect(output.usage.providerExtra).toBeUndefined();
	});
});
