import { describe, expect, it } from "vitest";
import { describeKeptProviders, planProviderGeneration } from "../scripts/provider-generation-plan.ts";

describe("planProviderGeneration", () => {
	it("keeps a provider whose fetch failed and still emits the fetched ones", () => {
		// The 2026-09-19 build: every provider but kimi-coding came back.
		const plan = planProviderGeneration({
			requestedProviderIds: ["anthropic", "openai"],
			fetchedProviderIds: ["anthropic", "openai"],
			keepableProviderIds: ["kimi-coding"],
		});

		expect(plan.freshProviderIds).toEqual(["anthropic", "openai"]);
		expect(plan.keptProviderIds).toEqual(["kimi-coding"]);
		expect(plan.outputProviderIds).toEqual(["anthropic", "kimi-coding", "openai"]);
		expect(plan.missingProviderIds).toEqual([]);
	});

	it("keeps nothing when every provider was fetched", () => {
		const plan = planProviderGeneration({
			requestedProviderIds: ["anthropic", "openai"],
			fetchedProviderIds: ["openai", "anthropic"],
			keepableProviderIds: [],
		});

		expect(plan.keptProviderIds).toEqual([]);
		expect(plan.outputProviderIds).toEqual(["anthropic", "openai"]);
		expect(describeKeptProviders(plan.keptProviderIds)).toBeUndefined();
	});

	it("reports a requested provider that can be neither fetched nor kept", () => {
		const plan = planProviderGeneration({
			requestedProviderIds: ["anthropic", "kimi-coding"],
			fetchedProviderIds: ["anthropic"],
			keepableProviderIds: [],
		});

		expect(plan.missingProviderIds).toEqual(["kimi-coding"]);
		expect(plan.outputProviderIds).toEqual(["anthropic"]);
	});

	it("keeps a requested provider when its data is on disk", () => {
		const plan = planProviderGeneration({
			requestedProviderIds: ["anthropic", "kimi-coding"],
			fetchedProviderIds: ["anthropic"],
			keepableProviderIds: ["kimi-coding"],
		});

		expect(plan.missingProviderIds).toEqual([]);
		expect(plan.keptProviderIds).toEqual(["kimi-coding"]);
		expect(plan.outputProviderIds).toEqual(["anthropic", "kimi-coding"]);
	});

	it("never lists a provider twice and sorts every list", () => {
		const plan = planProviderGeneration({
			requestedProviderIds: ["openai", "anthropic", "openai"],
			fetchedProviderIds: ["openai", "anthropic"],
			keepableProviderIds: ["zai", "kimi-coding", "kimi-coding"],
		});

		expect(plan.outputProviderIds).toEqual(["anthropic", "kimi-coding", "openai", "zai"]);
		expect(plan.keptProviderIds).toEqual(["kimi-coding", "zai"]);
		expect(new Set(plan.outputProviderIds).size).toBe(plan.outputProviderIds.length);
	});

	it("names the kept providers in one line", () => {
		expect(describeKeptProviders(["kimi-coding", "zai"])).toBe(
			"Kept the existing generated catalog and data for 2 provider(s) this run produced no models for: kimi-coding, zai",
		);
	});
});
