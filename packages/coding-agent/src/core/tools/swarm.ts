import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const SWARM_IDENTITY_VARIABLES = [
	"SWARM_HOME",
	"SWARM_SOCKET",
	"SWARM_RUN_ID",
	"SWARM_NODE_ID",
	"SWARM_DISPATCH_ID",
	"SWARM_SESSION_ID",
	"SWARM_NODE_TYPE",
	"SWARM_WORKTREE",
	"SWARM_DISPATCH_TOKEN",
] as const;

const swarmHandoffSchema = Type.Object({
	status: Type.Union([
		Type.Literal("done"),
		Type.Literal("partial"),
		Type.Literal("blocked"),
		Type.Literal("stopped_on_premise"),
	]),
	done: Type.String({ description: "What was completed" }),
	deviations: Type.String({ description: "Any deviation from the brief" }),
	findings: Type.String({ description: "Findings to pass to the parent" }),
	concerns: Type.String({ description: "Outstanding concerns" }),
	blocked_by: Type.String({ description: "What is blocking progress, if anything" }),
	follow_ups: Type.String({ description: "Recommended follow-up work" }),
	spec_coverage: Type.Optional(Type.String({ description: "How the specification was covered, when required" })),
});

export type SwarmHandoffInput = Static<typeof swarmHandoffSchema>;

export interface SwarmHandoffAccepted {
	readonly body_ref: string;
	readonly accepted: true;
}

export interface SwarmHandoffRefusal {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
}

export type SwarmHandoffResult = { readonly ok: true; readonly result: SwarmHandoffAccepted } | SwarmHandoffRefusal;

export interface SwarmHandoffHarness {
	handoff: (input: SwarmHandoffInput, signal?: AbortSignal) => Promise<SwarmHandoffResult>;
}

export interface SwarmHandoffToolOptions {
	/** Test or embedding seam. Defaults to the `swarm harness handoff` CLI. */
	harness?: SwarmHandoffHarness;
	/** Command resolved from PATH when no harness is supplied. Defaults to `swarm`. */
	command?: string;
}

export class SwarmHandoffError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "SwarmHandoffError";
		this.code = code;
	}
}

export function hasSwarmIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
	return SWARM_IDENTITY_VARIABLES.every((name) => {
		const value = env[name];
		return typeof value === "string" && value.length > 0;
	});
}

interface CommandResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
}

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

function runCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<CommandResult> {
	if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));

	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd,
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let aborted = false;

		const cleanup = (): void => {
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => {
			aborted = true;
			child.kill("SIGTERM");
		};
		const append = (target: "stdout" | "stderr", chunk: string): void => {
			if (settled) return;
			if (
				Buffer.byteLength(target === "stdout" ? stdout + chunk : stderr + chunk, "utf8") > MAX_COMMAND_OUTPUT_BYTES
			) {
				child.kill("SIGTERM");
				fail(new Error("swarm harness produced too much output"));
				return;
			}
			if (target === "stdout") stdout += chunk;
			else stderr += chunk;
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => append("stdout", chunk));
		child.stderr.on("data", (chunk: string) => append("stderr", chunk));
		child.once("error", (error: Error) => fail(error));
		child.once("close", (exitCode: number | null, signalCode: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			resolve({ exitCode, signal: signalCode, stdout, stderr });
		});
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHarnessResult(output: string, commandResult: CommandResult): SwarmHandoffResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.trim());
	} catch {
		const detail = commandResult.stderr.trim();
		throw new Error(`swarm harness returned invalid JSON${detail.length > 0 ? `: ${detail}` : ""}`);
	}
	if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
		throw new Error("swarm harness returned an invalid response");
	}
	if (parsed.ok) {
		const result = parsed.result;
		if (!isRecord(result) || result.accepted !== true || typeof result.body_ref !== "string") {
			throw new Error("swarm harness returned an invalid handoff result");
		}
		if (commandResult.exitCode !== 0) {
			throw new Error(`swarm harness exited with code ${String(commandResult.exitCode)}`);
		}
		return {
			ok: true,
			result: { accepted: true, body_ref: result.body_ref },
		};
	}
	const error = parsed.error;
	if (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string") {
		throw new Error("swarm harness returned an invalid refusal");
	}
	return { ok: false, code: error.code, message: error.message };
}

export function createCliSwarmHandoffHarness(cwd: string, command = "swarm"): SwarmHandoffHarness {
	return {
		async handoff(input, signal) {
			const directory = await mkdtemp(join(tmpdir(), "pi-swarm-handoff-"));
			try {
				const path = join(directory, "handoff.json");
				await writeFile(path, `${JSON.stringify(input)}\n`, "utf8");
				const commandResult = await runCommand(command, ["harness", "handoff", path], cwd, signal);
				if (commandResult.signal !== null && commandResult.stdout.trim().length === 0) {
					throw new Error(`swarm harness ended with signal ${commandResult.signal}`);
				}
				return parseHarnessResult(commandResult.stdout, commandResult);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	};
}

export function createSwarmHandoffToolDefinition(
	cwd: string,
	options: SwarmHandoffToolOptions = {},
): ToolDefinition<typeof swarmHandoffSchema, SwarmHandoffAccepted> {
	const harness = options.harness ?? createCliSwarmHandoffHarness(cwd, options.command);
	return {
		name: "swarm_handoff",
		label: "swarm_handoff",
		description:
			"Submit the completed handoff to the swarm daemon. The daemon supplies identity, cost, tokens, tree state and the body reference.",
		promptSnippet: "Submit a completed handoff to the swarm parent",
		promptGuidelines: [
			"Use swarm_handoff once the node has completed its assigned work or is blocked.",
			"Do not include node, dispatch, session, token, cost or tree fields.",
		],
		parameters: swarmHandoffSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const response = await harness.handoff(params, signal);
			if (!response.ok) throw new SwarmHandoffError(response.code, response.message);
			return {
				content: [{ type: "text", text: `Handoff accepted: ${response.result.body_ref}` }],
				details: response.result,
				terminate: true,
			};
		},
	};
}

export function createSwarmHandoffTool(
	cwd: string,
	options: SwarmHandoffToolOptions = {},
): AgentTool<typeof swarmHandoffSchema, SwarmHandoffAccepted> {
	return wrapToolDefinition(createSwarmHandoffToolDefinition(cwd, options));
}
