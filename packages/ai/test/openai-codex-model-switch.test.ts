import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

const model = (id: string, provider: string): Model<"openai-codex-responses"> =>
	({
		id,
		name: id,
		api: "openai-codex-responses",
		provider,
		baseUrl: "http://localhost",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
	}) as Model<"openai-codex-responses">;

const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" };

function astraTurn(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-6-astra",
		content: [
			{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
			{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a" } },
		],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function context(): Context {
	return {
		systemPrompt: "BASE INSTRUCTIONS",
		messages: [
			{ role: "user", content: "start", timestamp: 0 },
			astraTurn(),
			{ role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
			{ role: "user", content: "continue", timestamp: 3 },
		],
	} as unknown as Context;
}

describe("Codex to Codex model switch", () => {
	it("keeps the encrypted reasoning and the paired call id, and adds the notice after the tool result", () => {
		const items = convertResponsesMessages(model("gpt-5.6-luna", "codex-proxy"), context(), new Set(["openai-codex", "codex-proxy"]), { includeSystemPrompt: false }) as unknown as Array<Record<string, unknown>>;
		const kinds = items.map((item) => item.type ?? item.role);
		expect(kinds).toEqual(["user", "reasoning", "function_call", "function_call_output", "developer", "user"]);
		expect(items[1].encrypted_content).toBe("sealed");
		expect(items[2].id).toBe("fc_1");
		const notice = (items[4].content as Array<{ text: string }>)[0].text;
		expect(notice.startsWith("<model_switch>\nThe user was previously using a different model.")).toBe(true);
		expect(notice).toContain("BASE INSTRUCTIONS");
		expect(notice.endsWith("</model_switch>")).toBe(true);
	});

	it("adds nothing when the model is unchanged", () => {
		const items = convertResponsesMessages(model("gpt-6-astra", "openai-codex"), context(), new Set(["openai-codex"]), { includeSystemPrompt: false }) as unknown as Array<Record<string, unknown>>;
		expect(items.map((item) => item.type ?? item.role)).toEqual(["user", "reasoning", "function_call", "function_call_output", "user"]);
	});
});
