import { env as bindings } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobs } from "../src/capabilities/jobs";
import type { Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";
import { runTriggeredJobs } from "../src/jobs/runner";

const now = Date.parse("2026-08-20T10:00:00Z");
const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};
const createInput = {
	name: "Daily brief",
	code: "export default async function main() { return await ayo.whoami({}); }",
	schedule: { type: "cron" as const, expression: "0 8 * * *" },
	timezone: "Europe/Berlin",
};

function createHarness() {
	const env = {
		JOBS_DB: bindings.JOBS_DB,
		OAUTH_KV: bindings.OAUTH_KV,
	} as unknown as Env;
	return { env, dispatch: buildDispatchTable(jobs, env, props) };
}

async function createStoredJob(
	dispatch: ReturnType<typeof buildDispatchTable>,
) {
	return dispatch.job_create!(createInput) as Promise<{
		created: boolean;
		job: { id: string };
	}>;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("job capabilities", () => {
	it("creates with the real default expiry in one call", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();

		await expect(dispatch.job_create!(createInput)).resolves.toMatchObject({
			created: true,
			job: {
				name: "Daily brief",
				ownerProps: props,
				expiresAt: "2026-09-19T10:00:00.000Z",
				nextRunAt: "2026-08-21T06:00:00.000Z",
				runCount: 0,
			},
		});
	});

	it("creates and reads a trigger-only job", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, dispatch } = createHarness();
		const trigger = { source: "bureau", kind: "mail.received" };

		const created = (await dispatch.job_create!({
			name: "Tag new mail",
			code: createInput.code,
			trigger,
		})) as { job: { id: string; nextRunAt: string | null } };
		expect(created.job.nextRunAt).toBeNull();
		await expect(dispatch.job_list!({})).resolves.toMatchObject({
			jobs: [{ id: created.job.id, trigger, scheduleSummary: null }],
		});
		await expect(dispatch.job_read!({ id: created.job.id })).resolves.toMatchObject({
			trigger,
			nextRunAt: null,
		});

		const waits: Promise<unknown>[] = [];
		const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
		const execute = vi
			.fn()
			.mockResolvedValueOnce({ result: { skipped: true }, logs: [] })
			.mockResolvedValueOnce({ result: "x".repeat(5_000), logs: [] });
		await runTriggeredJobs(
			env,
			context,
			"bureau",
			{ id: "event-result", kind: "mail.received" },
			execute,
		);
		await Promise.all(waits.splice(0));
		await runTriggeredJobs(
			env,
			context,
			"bureau",
			{ id: "event-truncated", kind: "mail.received" },
			execute,
		);
		await Promise.all(waits);

		const storedRuns = await env.JOBS_DB.prepare(
			`SELECT source, result_json FROM job_runs
			WHERE job_id = ?1 ORDER BY rowid`,
		)
			.bind(created.job.id)
			.all<{ source: string; result_json: string }>();
		expect(storedRuns.results[0]).toEqual({
			source: "trigger",
			result_json: JSON.stringify({ skipped: true }),
		});
		expect(storedRuns.results[1]).toEqual({
			source: "trigger",
			result_json: expect.stringMatching(/…truncated$/),
		});
		expect(storedRuns.results[1]?.result_json).toHaveLength(4096);

		await expect(
			dispatch.job_read!({ id: created.job.id }),
		).resolves.toMatchObject({
			recentRuns: [
				{ source: "trigger", result: storedRuns.results[1]?.result_json },
				{ source: "trigger", result: { skipped: true } },
			],
		});
	});

	it("carries trigger.accounts through creation and persisted read", async () => {
		const { dispatch } = createHarness();
		const trigger = {
			source: "bureau",
			kind: "mail.received",
			accounts: ["ola@4wardthinkers.com"],
		};

		const created = (await dispatch.job_create!({
			name: "scoped",
			code: "export default async function main() {}",
			trigger,
		})) as { job: { id: string } };
		await expect(
			dispatch.job_read!({ id: created.job.id }),
		).resolves.toMatchObject({ trigger });
	});

	it("preserves, replaces, and clears trigger.accounts across updates", async () => {
		const { dispatch } = createHarness();
		const trigger = {
			source: "bureau",
			accounts: ["ola@4wardthinkers.com"],
		};
		const created = (await dispatch.job_create!({
			name: "scoped-update",
			code: "export default async function main() {}",
			trigger,
		})) as { job: { id: string } };
		const id = created.job.id;

		await dispatch.job_update!({ id, name: "renamed" });
		await expect(dispatch.job_read!({ id })).resolves.toMatchObject({ trigger });

		const widened = { source: "bureau", accounts: ["a@example.com", "b@example.com"] };
		await dispatch.job_update!({ id, trigger: widened });
		await expect(dispatch.job_read!({ id })).resolves.toMatchObject({
			trigger: widened,
		});

		const cleared = { source: "bureau" };
		await dispatch.job_update!({ id, trigger: cleared });
		const final = (await dispatch.job_read!({ id })) as {
			trigger: Record<string, unknown>;
		};
		expect(final.trigger).toEqual(cleared);
		expect(final.trigger).not.toHaveProperty("accounts");
	});

	it("requires a schedule or trigger", async () => {
		const { dispatch } = createHarness();
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(
			dispatch.job_create!({ name: "Never", code: createInput.code }),
		).rejects.toThrow("schedule, a trigger, or both");
	});

	it("normalizes offset timestamps before storage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();

		await expect(
			dispatch.job_create!({
				...createInput,
				schedule: {
					type: "once",
					runAt: "2026-08-20T09:30:00-04:00",
				},
				expiresAt: "2026-08-20T10:00:00-04:00",
			}),
		).resolves.toMatchObject({
			job: {
				schedule: { runAt: "2026-08-20T13:30:00.000Z" },
				expiresAt: "2026-08-20T14:00:00.000Z",
				nextRunAt: "2026-08-20T13:30:00.000Z",
			},
		});
	});

	it("allows a null expiry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();

		await expect(
			dispatch.job_create!({ ...createInput, expiresAt: null }),
		).resolves.toMatchObject({ job: { expiresAt: null } });
	});

	it("merges and applies an update in one call", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const created = await createStoredJob(dispatch);
		const trigger = { source: "bureau", kind: "mail.received" };

		await expect(
			dispatch.job_update!({
				id: created.job.id,
				enabled: false,
				name: "Paused brief",
				trigger,
			}),
		).resolves.toMatchObject({
			updated: true,
			job: {
				id: created.job.id,
				name: "Paused brief",
				enabled: false,
				code: createInput.code,
				schedule: createInput.schedule,
				trigger,
			},
		});
	});

	it("recomputes nextRunAt when a schedule changes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const created = await createStoredJob(dispatch);

		const result = (await dispatch.job_update!({
			id: created.job.id,
			schedule: { type: "interval", everyMs: 3_600_000 },
		})) as { job: { nextRunAt: string } };
		expect(result.job.nextRunAt).toBe("2026-08-20T11:00:00.000Z");
	});

	it("lists compact jobs, reads the full row, and deletes directly", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const created = await createStoredJob(dispatch);

		await expect(dispatch.job_list!({})).resolves.toEqual({
			jobs: [
				expect.objectContaining({
					id: created.job.id,
					name: "Daily brief",
					scheduleSummary: 'cron "0 8 * * *" (Europe/Berlin)',
					enabled: true,
					runCount: 0,
				}),
			],
		});
		await expect(dispatch.job_read!({ id: created.job.id })).resolves.toMatchObject(
			{
				id: created.job.id,
				code: createInput.code,
				ownerProps: props,
			},
		);
		await expect(dispatch.job_delete!({ id: created.job.id })).resolves.toEqual(
			{ deleted: true },
		);
		await expect(dispatch.job_list!({})).resolves.toEqual({ jobs: [] });
	});

	it("runs a stored job now, records the failed sandbox outcome, and advances", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const created = await createStoredJob(dispatch);

		await expect(dispatch.job_run_now!({ id: created.job.id })).resolves.toMatchObject(
			{
				status: "error",
				error: expect.stringContaining("no LOADER binding"),
				nextRunAt: "2026-08-21T06:00:00.000Z",
			},
		);
		await expect(dispatch.job_read!({ id: created.job.id })).resolves.toMatchObject(
			{
				runCount: 1,
				errorCount: 1,
				lastRunStatus: "error",
				recentRuns: [
					expect.objectContaining({
						jobId: created.job.id,
						status: "error",
						source: "manual",
					}),
				],
			},
		);
	});
});
