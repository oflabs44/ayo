import path from "node:path";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
	path.join(import.meta.dirname, "migrations"),
);

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			miniflare: {
				compatibilityDate: "2026-08-18",
				bindings: {
					SEARCH_OFFLINE: "true",
					TEST_MIGRATIONS: migrations,
				},
				d1Databases: ["JOBS_DB"],
				kvNamespaces: ["OAUTH_KV"],
			},
		}),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
	},
});
