import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			miniflare: {
				compatibilityDate: "2026-08-18",
				bindings: { SEARCH_OFFLINE: "true" },
				kvNamespaces: ["OAUTH_KV"],
			},
		}),
	],
});
