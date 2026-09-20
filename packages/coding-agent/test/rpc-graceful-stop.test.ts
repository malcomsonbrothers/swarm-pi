import { describe, expect, it } from "vitest";
import { registerRpcSignalHandlers } from "../src/modes/rpc/rpc-mode.ts";

describe("RPC graceful stop signal", () => {
	it("routes SIGUSR2 to the shared graceful-stop callback", () => {
		let gracefulStops = 0;
		const shutdowns: Array<[number, NodeJS.Signals]> = [];
		const cleanup = registerRpcSignalHandlers({
			onShutdown: (exitCode, signal) => shutdowns.push([exitCode, signal]),
			onGracefulStop: () => gracefulStops++,
		});
		try {
			process.emit("SIGUSR2");
			process.emit("SIGUSR2");
			expect(gracefulStops).toBe(2);
			expect(shutdowns).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("keeps SIGTERM and SIGHUP on the hard shutdown path", () => {
		const shutdowns: Array<[number, NodeJS.Signals]> = [];
		const cleanup = registerRpcSignalHandlers({
			onShutdown: (exitCode, signal) => shutdowns.push([exitCode, signal]),
			onGracefulStop: () => {},
		});
		try {
			process.emit("SIGTERM");
			if (process.platform !== "win32") process.emit("SIGHUP");
			expect(shutdowns).toContainEqual([143, "SIGTERM"]);
			if (process.platform !== "win32") expect(shutdowns).toContainEqual([129, "SIGHUP"]);
		} finally {
			cleanup();
		}
	});
});
