/**
 * Which providers a generation run writes, and which it keeps as they are.
 *
 * `generate-models` fetches every provider's catalogue over the network. When a
 * fetch fails, that provider simply has no models in the run, and the writer
 * used to treat "no models this run" as "delete this provider": on 2026-09-19 a
 * failed fetch removed src/providers/kimi-coding.models.ts and
 * src/providers/data/kimi-coding.json, and the offline part of the build then
 * failed on the missing data. Generation must never destroy what it could not
 * fetch, so a provider that is on disk but absent from this run is kept.
 */
export interface ProviderGenerationPlan {
	/** Providers written from this run's fetch, sorted. */
	freshProviderIds: string[];
	/** Providers kept from the previous generation because this run has no models for them, sorted. */
	keptProviderIds: string[];
	/** Every provider the run should emit, sorted. */
	outputProviderIds: string[];
	/** Providers that are neither fresh nor keepable: a genuine, unrecoverable gap. */
	missingProviderIds: string[];
}

export interface ProviderGenerationPlanInput {
	/** Providers this run must emit (the fetched set, or the existing set when hydrating). */
	requestedProviderIds: Iterable<string>;
	/** Providers this run actually produced models for. */
	fetchedProviderIds: Iterable<string>;
	/** Providers whose previously generated data is present on disk and readable. */
	keepableProviderIds: Iterable<string>;
}

function sortedUnique(values: Iterable<string>): string[] {
	return Array.from(new Set(values)).sort();
}

export function planProviderGeneration(input: ProviderGenerationPlanInput): ProviderGenerationPlan {
	const fetched = new Set(input.fetchedProviderIds);
	const keepable = new Set(input.keepableProviderIds);
	const requested = sortedUnique(input.requestedProviderIds);

	const freshProviderIds = requested.filter((providerId) => fetched.has(providerId));
	const notFetched = requested.filter((providerId) => !fetched.has(providerId));
	const keptProviderIds = notFetched.filter((providerId) => keepable.has(providerId));
	const missingProviderIds = notFetched.filter((providerId) => !keepable.has(providerId));

	// Anything on disk that this run did not fetch is kept too, even when the run
	// did not ask for it: dropping it would delete a shard the aggregator imports.
	for (const providerId of keepable) {
		if (fetched.has(providerId) || keptProviderIds.includes(providerId)) continue;
		keptProviderIds.push(providerId);
	}
	keptProviderIds.sort();

	return {
		freshProviderIds,
		keptProviderIds,
		outputProviderIds: sortedUnique([...freshProviderIds, ...keptProviderIds]),
		missingProviderIds,
	};
}

/** The one line the generator prints when it kept providers it could not fetch. */
export function describeKeptProviders(keptProviderIds: readonly string[]): string | undefined {
	if (keptProviderIds.length === 0) return undefined;
	return `Kept the existing generated catalog and data for ${keptProviderIds.length} provider(s) this run produced no models for: ${keptProviderIds.join(", ")}`;
}
