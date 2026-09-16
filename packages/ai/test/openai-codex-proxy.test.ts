import { describe, expect, it } from "vitest";
import {
	buildBaseCodexHeaders,
	extractAccountId,
	resolveCodexTransport,
	resolveCodexUrl,
	resolveCodexWebSocketUrl,
} from "../src/api/openai-codex-responses.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";

function tokenWithPayload(payload: Record<string, unknown>): string {
	return `header.${btoa(JSON.stringify(payload))}.signature`;
}

describe("OpenAI Codex proxy support", () => {
	it("resolves the supported Codex base URL forms", () => {
		expect(resolveCodexUrl()).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(resolveCodexUrl("https://chatgpt.com/backend-api")).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
		expect(resolveCodexUrl("https://proxy.example/v1/codex")).toBe("https://proxy.example/v1/codex/responses");
		expect(resolveCodexUrl("https://proxy.example/v1/codex/responses")).toBe(
			"https://proxy.example/v1/codex/responses",
		);
		expect(resolveCodexUrl("http://proxy.example/v1/responses")).toBe("http://proxy.example/v1/responses");
		expect(resolveCodexWebSocketUrl("http://proxy.example/v1/responses")).toBe("ws://proxy.example/v1/responses");
	});

	it("uses SSE automatically for proxy bases while preserving explicit transports", () => {
		expect(resolveCodexTransport("auto")).toBe("auto");
		expect(resolveCodexTransport("auto", "http://proxy.example/v1/responses")).toBe("sse");
		expect(resolveCodexTransport("websocket", "http://proxy.example/v1/responses")).toBe("websocket");
		expect(resolveCodexTransport("sse", "http://proxy.example/v1/responses")).toBe("sse");
	});

	it("extracts an account ID only when the JWT contains one", () => {
		expect(
			extractAccountId(
				tokenWithPayload({
					"https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
				}),
			),
		).toBe("account-123");
		expect(extractAccountId(tokenWithPayload({ sub: "user-123" }))).toBeNull();
		expect(extractAccountId("plain-proxy-key")).toBeNull();
	});

	it("builds headers with or without the JWT account ID", () => {
		const withAccount = buildBaseCodexHeaders(undefined, undefined, "account-123", "token");
		expect(withAccount.get("Authorization")).toBe("Bearer token");
		expect(withAccount.get("chatgpt-account-id")).toBe("account-123");

		const withoutAccount = buildBaseCodexHeaders(
			{ "chatgpt-account-id": "stale-account" },
			{ "chatgpt-account-id": "configured-account" },
			null,
			"plain-proxy-key",
		);
		expect(withoutAccount.has("chatgpt-account-id")).toBe(false);
		expect(withoutAccount.get("Authorization")).toBe("Bearer plain-proxy-key");
	});

	it("resolves stored API-key and OAuth credentials for the provider", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({
			credentials,
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(openaiCodexProvider());

		await credentials.modify("openai-codex", async () => ({ type: "api_key", key: "plain-proxy-key" }));
		const apiKeyAuth = await models.getAuth("openai-codex");
		expect(apiKeyAuth?.auth.apiKey).toBe("plain-proxy-key");
		expect((await models.getAuth("openai-codex", { apiKey: "cli-proxy-key" }))?.auth.apiKey).toBe("cli-proxy-key");

		await credentials.modify("openai-codex", async () => ({
			type: "oauth",
			access: "oauth-access-token",
			refresh: "oauth-refresh-token",
			expires: Date.now() + 10 * 60_000,
		}));
		const oauthAuth = await models.getAuth("openai-codex");
		expect(oauthAuth?.auth.apiKey).toBe("oauth-access-token");
		expect(oauthAuth?.source).toBe("OAuth");
	});
});
