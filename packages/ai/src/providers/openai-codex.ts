import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	return createProvider({
		id: "openai-codex",
		name: "OpenAI Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			apiKey: envApiKeyAuth("OpenAI Codex API key", ["OPENAI_CODEX_API_KEY"]),
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT Plus/Pro)",
				isSubscription: true,
				load: loadOpenAICodexOAuth,
			}),
		},
		models: Object.values(OPENAI_CODEX_MODELS),
		api: openAICodexResponsesApi(),
	});
}
