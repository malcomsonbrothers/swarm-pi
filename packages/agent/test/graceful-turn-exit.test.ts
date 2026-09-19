import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "../src/index.ts";

// The graceful turn exit the daemon asks for with SIGUSR2: the turn in flight
// finishes, every tool call of that turn records its result, and no further
// model request is made.

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function toolCall(id: string, value: string): ToolCallContent {
	return { type: "toolCall", id, name: "echo", arguments: { value } };
}

const echoSchema = Type.Object({ value: Type.String() });

function createEchoTool(executed: string[], onExecute?: () => void): AgentTool<typeof echoSchema, { value: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: echoSchema,
		async execute(_toolCallId, params) {
			onExecute?.();
			executed.push(params.value);
			return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
		},
	};
}

/** A fake model: turn one asks for two tools, every later turn answers with text. */
function createStreamFn(state: { calls: number }): StreamFn {
	return () => {
		state.calls++;
		const call = state.calls;
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const reason = call === 1 ? "toolUse" : "stop";
			const message =
				call === 1
					? assistantMessage([toolCall("tool-1", "one"), toolCall("tool-2", "two")], reason)
					: assistantMessage([{ type: "text", text: `turn ${call}` }], reason);
			stream.push({ type: "done", reason, message });
		});
		return stream;
	};
}

function createAgent(streamFn: StreamFn, tools: AgentTool<any>[]): Agent {
	return new Agent({
		streamFn,
		initialState: {
			systemPrompt: "",
			tools,
			model: {
				id: "mock",
				name: "mock",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 2048,
			} as never,
		},
	});
}

describe("requestStopAfterTurn", () => {
	it("finishes the turn in flight, records every tool result, and makes no further request", async () => {
		const state = { calls: 0 };
		const executed: string[] = [];
		let agent: Agent | undefined;
		// Ask to stop while the first turn's tools are still running.
		const tool = createEchoTool(executed, () => agent?.requestStopAfterTurn());
		agent = createAgent(createStreamFn(state), [tool]);

		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("echo twice");

		expect(state.calls).toBe(1);
		expect(executed).toEqual(["one", "two"]);
		expect(agent.stopAfterTurnRequested).toBe(true);

		const roles = agent.state.messages.map((message) => message.role);
		expect(roles).toEqual(["system", "user", "assistant", "toolResult", "toolResult"]);

		const recorded = agent.state.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => (message as { toolCallId: string }).toolCallId);
		expect(recorded).toEqual(["tool-1", "tool-2"]);

		// turn_end carries both results, and agent_end is the last event.
		const turnEnd = events.find((event) => event.type === "turn_end");
		expect(turnEnd && turnEnd.type === "turn_end" ? turnEnd.toolResults.length : 0).toBe(2);
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("leaves a queued follow-up unsent instead of starting another request", async () => {
		const state = { calls: 0 };
		const executed: string[] = [];
		let agent: Agent | undefined;
		const tool = createEchoTool(executed, () => agent?.requestStopAfterTurn());
		agent = createAgent(createStreamFn(state), [tool]);

		agent.followUp({ role: "user", content: "and then this", timestamp: Date.now() });
		await agent.prompt("echo twice");

		expect(state.calls).toBe(1);
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("is idempotent and clearable", async () => {
		const state = { calls: 0 };
		const agent = createAgent(createStreamFn(state), []);

		agent.requestStopAfterTurn();
		agent.requestStopAfterTurn();
		expect(agent.stopAfterTurnRequested).toBe(true);

		// The request is made while idle: the next prompt still runs its one turn
		// and then stops, exactly as a turn in flight would have.
		await agent.prompt("hello");
		expect(state.calls).toBe(1);

		agent.clearStopAfterTurnRequest();
		expect(agent.stopAfterTurnRequested).toBe(false);
		await agent.prompt("again");
		expect(state.calls).toBe(2);
	});

	it("does not stop a turn when nothing asked it to", async () => {
		const state = { calls: 0 };
		const executed: string[] = [];
		const agent = createAgent(createStreamFn(state), [createEchoTool(executed)]);

		await agent.prompt("echo twice");

		// Turn one used tools, so the loop runs a second request on its own.
		expect(state.calls).toBe(2);
		expect(executed).toEqual(["one", "two"]);
	});
});
