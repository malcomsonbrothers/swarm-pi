import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	onWrite: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
		rpcIo.onWrite?.(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

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

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	preflightGate?: Promise<void>;
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
	getStreamCalls: () => number;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	let streamCalls = 0;
	const extensionsResult = options.preflightGate
		? await createTestExtensionsResult([
				(pi) => {
					pi.on("before_agent_start", async () => {
						await options.preflightGate;
					});
				},
			])
		: undefined;

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			streamCalls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				await session.abort();
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
		getStreamCalls: () => streamCalls,
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	preflightGate?: Promise<void>;
}): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
	runtimeHost: AgentSessionRuntime;
	getStreamCalls: () => number;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const signalNames: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGUSR2"];
	const signalListeners = new Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>();
	for (const signal of signalNames) signalListeners.set(signal, new Set(process.listeners(signal)));
	const { runtimeHost, cleanup: cleanupRuntime, getStreamCalls } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	const cleanup = async () => {
		await cleanupRuntime();
		for (const signal of signalNames) {
			for (const listener of process.listeners(signal)) {
				if (!signalListeners.get(signal)?.has(listener)) process.off(signal, listener);
			}
		}
	};

	return { lineHandler: rpcIo.lineHandler!, cleanup, runtimeHost, getStreamCalls };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.onWrite = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("runs a prompt acknowledged before graceful stop", async () => {
		const { lineHandler, cleanup, getStreamCalls } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			return undefined as never;
		});
		let sentStop = false;
		rpcIo.onWrite = (line) => {
			if (!sentStop && line.includes('"id":"accepted-before-stop"') && line.includes('"success":true')) {
				sentStop = true;
				process.emit("SIGUSR2");
			}
		};

		try {
			lineHandler(JSON.stringify({ id: "accepted-before-stop", type: "prompt", message: "Run this" }));
			await vi.waitFor(() => expect(exitCodes).toEqual([0]));
			expect(getStreamCalls()).toBe(1);
			expect(getPromptResponses(rpcIo.outputLines, "accepted-before-stop")).toHaveLength(1);
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("waits for an in-flight bash command and its session entry before graceful exit", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const exitCodes: number[] = [];
		let exitSnapshot: { responseCount: number; hasBashEntry: boolean } | undefined;
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			exitSnapshot = {
				responseCount: parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "bash-stop" && record.command === "bash",
				).length,
				hasBashEntry: runtimeHost.session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && entry.message.role === "bashExecution"),
			};
			return undefined as never;
		});

		try {
			lineHandler(JSON.stringify({ id: "bash-stop", type: "bash", command: "sleep 0.05; printf bash-done" }));
			process.emit("SIGUSR2");

			await vi.waitFor(() => expect(exitCodes).toEqual([0]));
			expect(exitSnapshot).toEqual({ responseCount: 1, hasBashEntry: true });
			expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
				expect.objectContaining({ id: "bash-stop", command: "bash", success: true }),
			);
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("refuses a prompt still in preflight after graceful stop without a provider request", async () => {
		let releasePreflight!: () => void;
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		const { lineHandler, cleanup, getStreamCalls } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			preflightGate,
		});
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			return undefined as never;
		});

		try {
			lineHandler(JSON.stringify({ id: "preflight-stop", type: "prompt", message: "must not run" }));
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(getPromptResponses(rpcIo.outputLines, "preflight-stop")).toHaveLength(0);

			process.emit("SIGUSR2");
			releasePreflight();

			await vi.waitFor(() => expect(exitCodes).toEqual([0]));
			expect(getPromptResponses(rpcIo.outputLines, "preflight-stop")[0]).toMatchObject({
				success: false,
				error: "No new provider request after graceful stop",
			});
			expect(getStreamCalls()).toBe(0);
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("reports acknowledged queued prompts, steering, and follow-ups that graceful stop cannot deliver", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 1000 });
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			return undefined as never;
		});

		try {
			lineHandler(JSON.stringify({ id: "undelivered-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "undelivered-start")).toHaveLength(1));
			lineHandler(
				JSON.stringify({
					id: "undelivered-prompt",
					type: "prompt",
					message: "Queued prompt",
					streamingBehavior: "steer",
				}),
			);
			lineHandler(JSON.stringify({ id: "undelivered-steer", type: "steer", message: "Queued steer" }));
			lineHandler(JSON.stringify({ id: "undelivered-follow-up", type: "follow_up", message: "Queued follow-up" }));
			await vi.waitFor(() => {
				for (const id of ["undelivered-prompt", "undelivered-steer", "undelivered-follow-up"]) {
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
						expect.objectContaining({ id, type: "response", success: true }),
					);
				}
			});

			process.emit("SIGUSR2");
			await vi.waitFor(() => expect(exitCodes).toEqual([0]));
			for (const [id, command] of [
				["undelivered-prompt", "prompt"],
				["undelivered-steer", "steer"],
				["undelivered-follow-up", "follow_up"],
			] as const) {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					type: "command_not_delivered",
					id,
					command,
					error: "RPC session stopped gracefully before command was delivered",
				});
			}
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("reports only the duplicate queued command that is consumed without a provider turn", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			return undefined as never;
		});
		let sawTwoQueuedFollowUps = false;
		let stopSent = false;
		rpcIo.onWrite = (line) => {
			const record = JSON.parse(line) as { type?: string; followUp?: string[] };
			if (record.type !== "queue_update") return;
			if (record.followUp?.length === 2) sawTwoQueuedFollowUps = true;
			if (sawTwoQueuedFollowUps && !stopSent && record.followUp?.length === 0) {
				stopSent = true;
				process.emit("SIGUSR2");
			}
		};

		try {
			lineHandler(JSON.stringify({ id: "duplicate-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "duplicate-start")).toHaveLength(1));
			lineHandler(
				JSON.stringify({
					id: "duplicate-one",
					type: "follow_up",
					message: "same text",
				}),
			);
			lineHandler(
				JSON.stringify({
					id: "duplicate-two",
					type: "follow_up",
					message: "same text",
				}),
			);
			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				for (const id of ["duplicate-one", "duplicate-two"]) {
					expect(records).toContainEqual(expect.objectContaining({ id, type: "response", success: true }));
				}
			});
			await vi.waitFor(() => expect(exitCodes).toEqual([0]));

			const notDelivered = parseOutputLines(rpcIo.outputLines).filter(
				(record) => record.type === "command_not_delivered",
			);
			expect(notDelivered).toEqual([
				{
					type: "command_not_delivered",
					id: "duplicate-two",
					command: "follow_up",
					error: "RPC session stopped gracefully before command was delivered",
				},
			]);
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("treats stdin EOF as graceful stop for an accepted prompt", async () => {
		const { lineHandler, cleanup, getStreamCalls } = await startRpcMode({ withAuth: true, responseDelayMs: 25 });
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			return undefined as never;
		});
		let eofSent = false;
		rpcIo.onWrite = (line) => {
			if (!eofSent && line.includes('"id":"eof-accepted"') && line.includes('"success":true')) {
				eofSent = true;
				process.stdin.emit("end");
			}
		};

		try {
			lineHandler(JSON.stringify({ id: "eof-accepted", type: "prompt", message: "Finish before EOF" }));
			await vi.waitFor(() => expect(exitCodes.length).toBeGreaterThan(0));
			expect(exitCodes.every((code) => code === 0)).toBe(true);
			expect(getStreamCalls()).toBe(1);
			expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(expect.objectContaining({ type: "agent_end" }));
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("rejects a new RPC command after graceful stop and names the stop", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			return undefined as never;
		});

		try {
			process.emit("SIGUSR2");
			lineHandler(JSON.stringify({ id: "late-state", type: "get_state" }));

			await vi.waitFor(() => expect(exitCodes).toEqual([0]));
			expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
				id: "late-state",
				type: "response",
				command: "get_state",
				success: false,
				error: "RPC session is stopping gracefully",
			});
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("preserves graceful exit code when SIGTERM arrives during graceful shutdown", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 25 });
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			return undefined as never;
		});

		try {
			lineHandler(JSON.stringify({ id: "sigterm-during-graceful", type: "prompt", message: "Start" }));
			await vi.waitFor(() =>
				expect(getPromptResponses(rpcIo.outputLines, "sigterm-during-graceful")).toHaveLength(1),
			);
			process.emit("SIGUSR2");
			process.emit("SIGTERM");
			await vi.waitFor(() => expect(exitCodes).toEqual([0]));
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("returns and clears queued steering and follow-up messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: "clear-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-start")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-steering",
					type: "prompt",
					message: "Change direction",
					streamingBehavior: "steer",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-follow-up",
					type: "prompt",
					message: "Summarize when finished",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-follow-up")).toHaveLength(1);
			});

			lineHandler(JSON.stringify({ id: "clear", type: "clear_queue" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "clear",
					type: "response",
					command: "clear_queue",
					success: true,
					data: {
						steering: ["Change direction"],
						followUp: ["Summarize when finished"],
					},
				});
			});

			await sleep(600);
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
});
