import { describe, expect, test } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.ts";
import { CAPABILITIES, formatCapabilities } from "../src/cli/capabilities.ts";

describe("--capabilities", () => {
	test("parses the flag", () => {
		expect(parseArgs(["--capabilities"]).capabilities).toBe(true);
		expect(parseArgs(["--capabilities"]).diagnostics).toEqual([]);
		expect(parseArgs(["--capabilities"]).unknownFlags.size).toBe(0);
	});

	test("is absent when not given", () => {
		expect(parseArgs(["-p", "hello"]).capabilities).toBeUndefined();
	});

	test("prints one capability per line, including graceful-turn-exit", () => {
		const output = formatCapabilities();
		const lines = output.split("\n");

		expect(output.endsWith("\n")).toBe(true);
		expect(lines[lines.length - 1]).toBe("");
		expect(lines.slice(0, -1)).toEqual([...CAPABILITIES]);
		expect(lines).toContain("graceful-turn-exit");
		for (const line of lines.slice(0, -1)) {
			expect(line).toMatch(/^[a-z0-9-]+$/);
		}
	});

	test("names no capability twice", () => {
		expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
	});

	test("is listed in the help text", () => {
		const lines: string[] = [];
		const realLog = console.log;
		console.log = (...args: unknown[]) => lines.push(args.join(" "));
		try {
			printHelp([]);
		} finally {
			console.log = realLog;
		}
		expect(lines.join("\n")).toContain("--capabilities");
	});
});
