import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const document = readFileSync(new URL("../docs/SWARM-FORK.md", import.meta.url), "utf8");

test("documents graceful-shutdown credential cancellation scope", () => {
	assert.match(document, /Cancellation of credential reads is out of scope for graceful shutdown\./);
	assert.match(document, /Cancellation of OAuth refreshes is out of scope for graceful shutdown\./);
});
