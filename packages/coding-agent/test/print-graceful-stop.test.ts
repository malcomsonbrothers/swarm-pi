import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => resolvePromise?.(),
	};
}

describe("print mode graceful stop", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ignores SIGTERM after SIGUSR2 while the prompt completes", async () => {
		const promptStarted = deferred();
		const finishPrompt = deferred();
		const dispose = vi.fn(async () => {});
		const requestStopAfterTurn = vi.fn();
		const runtimeHost = {
			session: {
				agent: { requestStopAfterTurn },
				bindExtensions: vi.fn(async () => {}),
				subscribe: vi.fn(() => () => {}),
				prompt: vi.fn(async () => {
					promptStarted.resolve();
					await finishPrompt.promise;
				}),
				state: { messages: [] },
			},
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			exitCodes.push(typeof code === "number" ? code : code ? Number(code) : 0);
			return undefined as never;
		});

		const run = runPrintMode(runtimeHost, { mode: "text", initialMessage: "hello" });
		await promptStarted.promise;
		process.emit("SIGUSR2");
		process.emit("SIGTERM");
		expect(exit).not.toHaveBeenCalled();

		finishPrompt.resolve();
		await expect(run).resolves.toBe(0);
		expect(requestStopAfterTurn).toHaveBeenCalledOnce();
		expect(exitCodes).toEqual([]);
		expect(dispose).toHaveBeenCalledOnce();
	});
});
