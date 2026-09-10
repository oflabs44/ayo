import { env } from "cloudflare:workers";
import {
	applyD1Migrations,
	type D1Migration,
} from "cloudflare:test";
import { beforeEach } from "vitest";

const testEnv = env as unknown as {
	JOBS_DB: D1Database;
	TEST_MIGRATIONS: D1Migration[];
};

// Setup runs outside per-test storage isolation. Each test starts from this
// migrated baseline, and repeated setup is safe because migrations are tracked.
await applyD1Migrations(testEnv.JOBS_DB, testEnv.TEST_MIGRATIONS);

beforeEach(async () => {
	await testEnv.JOBS_DB.batch([
		testEnv.JOBS_DB.prepare("DELETE FROM document_tickets"),
		testEnv.JOBS_DB.prepare("DELETE FROM job_runs"),
		testEnv.JOBS_DB.prepare("DELETE FROM jobs"),
	]);
});
