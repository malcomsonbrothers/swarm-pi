import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createSwarmHandoffTool,
	hasSwarmIdentity,
	type SwarmHandoffHarness,
	type SwarmHandoffInput,
} from "../src/core/tools/swarm.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const handoffInput: SwarmHandoffInput = {
	status: "done",
	done: "Implemented the requested change.",
	deviations: "None.",
	findings: "No findings.",
	concerns: "None.",
	blocked_by: "None.",
	follow_ups: "Run the targeted checks.",
};

function textOf(message: unknown): string {
	if (typeof message !== "object" || message === null || !("content" in message)) return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

describe("swarm_handoff", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("requires the complete swarm identity before native activation", () => {
		const identity = {
			SWARM_HOME: "/state",
			SWARM_SOCKET: "/state/daemon.sock",
			SWARM_RUN_ID: "run-1",
			SWARM_NODE_ID: "node-1",
			SWARM_DISPATCH_ID: "dispatch-1",
			SWARM_SESSION_ID: "session-1",
			SWARM_NODE_TYPE: "worker",
			SWARM_WORKTREE: "/worktree",
			SWARM_DISPATCH_TOKEN: "secret",
		};

		expect(hasSwarmIdentity(identity)).toBe(true);
		expect(hasSwarmIdentity({ ...identity, SWARM_DISPATCH_TOKEN: undefined })).toBe(false);
		expect(hasSwarmIdentity({ ...identity, SWARM_NODE_ID: "" })).toBe(false);
	});

	it("injects the native tool into a complete swarm session identity", async () => {
		const identity = {
			SWARM_HOME: "/state",
			SWARM_SOCKET: "/state/daemon.sock",
			SWARM_RUN_ID: "run-1",
			SWARM_NODE_ID: "node-1",
			SWARM_DISPATCH_ID: "dispatch-1",
			SWARM_SESSION_ID: "session-1",
			SWARM_NODE_TYPE: "worker",
			SWARM_WORKTREE: "/worktree",
			SWARM_DISPATCH_TOKEN: "test-token",
		} satisfies NodeJS.ProcessEnv;
		const previous = new Map<string, string | undefined>();
		for (const [name, value] of Object.entries(identity)) {
			previous.set(name, process.env[name]);
			process.env[name] = value;
		}

		const cwd = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
		await mkdir(join(cwd, "agent"), { recursive: true });
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			session = (
				await createAgentSession({
					cwd,
					agentDir: join(cwd, "agent"),
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager: SettingsManager.inMemory(),
					sessionManager: SessionManager.inMemory(cwd),
				})
			).session;
			expect(session.getActiveToolNames()).toContain("swarm_handoff");
			expect(session.getAllTools().map((tool) => tool.name)).toContain("swarm_handoff");
		} finally {
			session?.dispose();
			await rm(cwd, { recursive: true, force: true });
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("returns the daemon result and requests turn termination", async () => {
		const calls: SwarmHandoffInput[] = [];
		const swarmHarness: SwarmHandoffHarness = {
			handoff: async (input) => {
				calls.push(input);
				return { ok: true, result: { accepted: true, body_ref: "handoff-ref-1" } };
			},
		};
		const tool = createSwarmHandoffTool("/worktree", { harness: swarmHarness });

		const result = await tool.execute("call-1", handoffInput);

		expect(calls).toEqual([handoffInput]);
		expect(result).toMatchObject({
			details: { accepted: true, body_ref: "handoff-ref-1" },
			terminate: true,
		});
		expect(textOf(result)).toContain("handoff-ref-1");
	});

	it("shows an invalid call to the model, accepts its correction, and makes no third request", async () => {
		const calls: SwarmHandoffInput[] = [];
		const swarmHarness: SwarmHandoffHarness = {
			handoff: async (input) => {
				calls.push(input);
				return { ok: true, result: { accepted: true, body_ref: "handoff-ref-2" } };
			},
		};
		const tool = createSwarmHandoffTool("/worktree", { harness: swarmHarness });
		harness = await createHarness({
			responses: [
				{
					toolCalls: [
						{
							id: "invalid-call",
							name: "swarm_handoff",
							args: {
								status: "done",
								done: "Implemented the requested change.",
								deviations: "None.",
								findings: "No findings.",
								concerns: "None.",
								blocked_by: "None.",
							},
						},
					],
				},
				{
					toolCalls: [{ id: "corrected-call", name: "swarm_handoff", args: handoffInput }],
				},
			],
			tools: [tool],
			baseToolsOverride: { swarm_handoff: tool },
		});

		await harness.session.prompt("Finish the node and report the handoff.");

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(harness.faux.callCount).toBe(2);
		expect(calls).toEqual([handoffInput]);
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]).toMatchObject({ isError: true });
		expect(textOf(toolResults[0])).toContain("follow_ups");
		expect(toolResults[1]).toMatchObject({ isError: false });
		expect(textOf(toolResults[1])).toContain("handoff-ref-2");
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
	});
});
