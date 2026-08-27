import { env as bindings } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, OwnerProps } from "../src/env";
import {
	runDueJobs,
	runJobNow,
	runTriggeredJobs,
} from "../src/jobs/runner";
import {
	claimTriggeredRun,
	createJob,
	getJob,
	listJobRuns,
	updateJob,
	type JobRow,
} from "../src/jobs/store";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};
const now = Date.parse("2026-08-20T10:00:00Z");

function job(input: Partial<JobRow> & Pick<JobRow, "id">): JobRow {
	const { id, ...overrides } = input;
	return {
		id,
		name: input.id,
		code: `export default async function main() { return "${input.id}"; }`,
		schedule: { type: "interval", everyMs: 3_600_000 },
		timezone: "UTC",
		enabled: true,
		ownerProps: props,
		expiresAt: new Date(now + 86_400_000).toISOString(),
		nextRunAt: new Date(now - 60_000).toISOString(),
		createdAt: new Date(now - 86_400_000).toISOString(),
		updatedAt: new Date(now - 86_400_000).toISOString(),
		lastRunAt: null,
		lastRunStatus: null,
		lastRunError: null,
		lastDurationMs: null,
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		...overrides,
	};
}

function createHarness() {
	const env = { JOBS_DB: bindings.JOBS_DB } as unknown as Env;
	const waits: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: vi.fn((promise: Promise<unknown>) => waits.push(promise)),
	};
	return { env, ctx, waits };
}

async function settle(waits: Promise<unknown>[]) {
	await Promise.all(waits);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("triggered job runner", () => {
	it("matches the accounts list when set and every account when omitted", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(
			env,
			job({
				id: "account-match",
				schedule: undefined,
				trigger: {
					source: "bureau",
					accounts: ["ola@4wardthinkers.com", "second@example.com"],
				},
				nextRunAt: null,
			}),
		);
		await createJob(
			env,
			job({
				id: "account-mismatch",
				schedule: undefined,
				trigger: { source: "bureau", accounts: ["other@example.com"] },
				nextRunAt: null,
			}),
		);
		await createJob(
			env,
			job({
				id: "all-accounts",
				schedule: undefined,
				trigger: { source: "bureau" },
				nextRunAt: null,
			}),
		);
		const execute = vi.fn(async () => ({ logs: [] }));
		const event = {
			id: "event-acct",
			kind: "mail.received",
			account: "ola@4wardthinkers.com",
			data: { id: "m1" },
		};

		await runTriggeredJobs(env, ctx, "bureau", event, execute);
		await settle(waits);

		expect(execute).toHaveBeenCalledTimes(2);
		expect(await getJob(env, "account-match")).toMatchObject({ runCount: 1 });
		expect(await getJob(env, "account-mismatch")).toMatchObject({
			runCount: 0,
		});
		expect(await getJob(env, "all-accounts")).toMatchObject({ runCount: 1 });

		const accountless = {
			id: "event-anon",
			kind: "mail.received",
			data: { id: "m2" },
		};
		await runTriggeredJobs(env, ctx, "bureau", accountless, execute);
		await settle(waits);
		expect(await getJob(env, "account-match")).toMatchObject({ runCount: 1 });
		expect(await getJob(env, "all-accounts")).toMatchObject({ runCount: 2 });
	});

	it("matches source and optional kind while skipping disabled and expired jobs", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(
			env,
			job({
				id: "kind-match",
				schedule: undefined,
				trigger: { source: "bureau", kind: "mail.received" },
				nextRunAt: null,
			}),
		);
		await createJob(
			env,
			job({
				id: "source-match",
				schedule: undefined,
				trigger: { source: "bureau" },
				nextRunAt: null,
			}),
		);
		await createJob(
			env,
			job({
				id: "wrong-kind",
				schedule: undefined,
				trigger: { source: "bureau", kind: "mail.sent" },
				nextRunAt: null,
			}),
		);
		await createJob(
			env,
			job({
				id: "wrong-source",
				schedule: undefined,
				trigger: { source: "other" },
				nextRunAt: null,
			}),
		);
		await createJob(
			env,
			job({
				id: "disabled",
				schedule: undefined,
				trigger: { source: "bureau" },
				enabled: false,
				nextRunAt: null,
			}),
		);
		await createJob(
			env,
			job({
				id: "expired-trigger",
				schedule: undefined,
				trigger: { source: "bureau" },
				expiresAt: new Date(now).toISOString(),
				nextRunAt: null,
			}),
		);
		const execute = vi.fn(async () => ({ logs: [] }));
		const event = { id: "event-1", kind: "mail.received", data: { id: "m1" } };

		await runTriggeredJobs(env, ctx, "bureau", event, execute);
		await settle(waits);

		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({
				params: { event, source: "bureau" },
			}),
		);
		expect(await getJob(env, "kind-match")).toMatchObject({
			nextRunAt: null,
			runCount: 1,
		});
		expect(await getJob(env, "source-match")).toMatchObject({ runCount: 1 });
		expect(await getJob(env, "wrong-kind")).toMatchObject({ runCount: 0 });
		expect(await getJob(env, "wrong-source")).toMatchObject({ runCount: 0 });
		expect(await getJob(env, "disabled")).toMatchObject({ runCount: 0 });
		expect(await getJob(env, "expired-trigger")).toMatchObject({ runCount: 0 });
	});

	it("runs a redelivered event only once", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(
			env,
			job({
				id: "idempotent",
				schedule: undefined,
				trigger: { source: "bureau" },
				nextRunAt: null,
			}),
		);
		const execute = vi.fn(async () => ({ logs: [] }));
		const event = { id: "event-repeat", kind: "mail.received" };

		await runTriggeredJobs(env, ctx, "bureau", event, execute);
		await settle(waits);
		await runTriggeredJobs(env, ctx, "bureau", event, execute);
		await settle(waits);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(await listJobRuns(env, "idempotent")).toEqual([
			expect.objectContaining({ eventId: "event-repeat", status: "success" }),
		]);
	});

	it("claims concurrent deliveries through the database unique key", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env } = createHarness();
		await createJob(
			env,
			job({
				id: "concurrent-event",
				schedule: undefined,
				trigger: { source: "bureau" },
				nextRunAt: null,
			}),
		);
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = vi.fn(async () => {
			await blocked;
			return { logs: [] };
		});
		const firstWaits: Promise<unknown>[] = [];
		const secondWaits: Promise<unknown>[] = [];

		await Promise.all([
			runTriggeredJobs(
				env,
				{ waitUntil: (promise) => firstWaits.push(promise) },
				"bureau",
				{ id: "event-concurrent" },
				execute,
			),
			runTriggeredJobs(
				env,
				{ waitUntil: (promise) => secondWaits.push(promise) },
				"bureau",
				{ id: "event-concurrent" },
				execute,
			),
		]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(await listJobRuns(env, "concurrent-event")).toEqual([
			expect.objectContaining({
				eventId: "event-concurrent",
				status: "running",
			}),
		]);

		release();
		await settle([...firstWaits, ...secondWaits]);
		expect(await getJob(env, "concurrent-event")).toMatchObject({ runCount: 1 });
	});

	it("keeps idempotency claims after run evidence is pruned", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(
			env,
			job({
				id: "retained-claim",
				schedule: undefined,
				trigger: { source: "bureau" },
				nextRunAt: null,
			}),
		);
		const execute = vi.fn(async () => ({ logs: [] }));

		for (let index = 0; index < 55; index += 1) {
			await runTriggeredJobs(
				env,
				ctx,
				"bureau",
				{ id: `event-${index}` },
				execute,
			);
			await settle(waits);
		}
		await runTriggeredJobs(
			env,
			ctx,
			"bureau",
			{ id: "event-0" },
			execute,
		);
		await settle(waits);

		expect(execute).toHaveBeenCalledTimes(55);
		expect(await listJobRuns(env, "retained-claim", 100)).toHaveLength(50);
		await expect(
			env.JOBS_DB.prepare(
				"SELECT COUNT(*) AS count FROM event_claims WHERE job_id = ?1",
			)
				.bind("retained-claim")
				.first<{ count: number }>(),
		).resolves.toEqual({ count: 55 });
	});

	it("prunes event claims only after the 30-day replay horizon", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(
			env,
			job({
				id: "claim-horizon",
				schedule: undefined,
				trigger: { source: "bureau" },
				expiresAt: null,
				nextRunAt: null,
			}),
		);
		const execute = vi.fn(async () => ({ logs: [] }));
		const horizonMs = 30 * 24 * 60 * 60_000;

		await runTriggeredJobs(env, ctx, "bureau", { id: "event-old" }, execute);
		await settle(waits);
		vi.setSystemTime(now + horizonMs);
		await runTriggeredJobs(env, ctx, "bureau", { id: "event-boundary" }, execute);
		await settle(waits);
		await runTriggeredJobs(env, ctx, "bureau", { id: "event-old" }, execute);
		await settle(waits);
		expect(execute).toHaveBeenCalledTimes(2);

		vi.setSystemTime(now + horizonMs + 1);
		await runTriggeredJobs(env, ctx, "bureau", { id: "event-after" }, execute);
		await settle(waits);
		await runTriggeredJobs(env, ctx, "bureau", { id: "event-old" }, execute);
		await settle(waits);
		expect(execute).toHaveBeenCalledTimes(4);
	});

	it("does not claim stale code after a concurrent update", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env } = createHarness();
		await createJob(
			env,
			job({
				id: "updated-before-claim",
				schedule: undefined,
				trigger: { source: "bureau" },
				nextRunAt: null,
			}),
		);
		const stale = (await getJob(env, "updated-before-claim"))!;
		const updated = {
			...stale,
			code: 'export default async function main() { return "new"; }',
			updatedAt: new Date(now + 1).toISOString(),
		};
		await expect(updateJob(env, updated, stale.updatedAt)).resolves.toBe(true);

		await expect(
			claimTriggeredRun(env, stale, "event-after-update", now),
		).rejects.toThrow("changed before the event could be claimed");
		await expect(listJobRuns(env, stale.id)).resolves.toEqual([]);
	});

	it("propagates a claim failure after claiming and running other jobs", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		for (const id of ["claim-fails", "claim-healthy"]) {
			await createJob(
				env,
				job({
					id,
					schedule: undefined,
					trigger: { source: "bureau" },
					nextRunAt: null,
				}),
			);
		}
		await env.JOBS_DB.prepare(
			`CREATE TRIGGER reject_test_claim
			BEFORE INSERT ON event_claims
			WHEN NEW.job_id = 'claim-fails'
			BEGIN
				SELECT RAISE(ABORT, 'forced claim failure');
			END`,
		).run();
		const execute = vi.fn(async () => ({ logs: [] }));

		await expect(
			runTriggeredJobs(
				env,
				ctx,
				"bureau",
				{ id: "event-partial-claim" },
				execute,
			),
		).rejects.toThrow("claim-fails");
		await settle(waits);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(await getJob(env, "claim-fails")).toMatchObject({ runCount: 0 });
		expect(await getJob(env, "claim-healthy")).toMatchObject({
			runCount: 1,
		});
	});

	it("records one throwing triggered job and continues with the others", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		for (const id of ["trigger-broken", "trigger-healthy"]) {
			await createJob(
				env,
				job({
					id,
					schedule: undefined,
					trigger: { source: "bureau" },
					nextRunAt: null,
				}),
			);
		}
		const execute = vi.fn(async ({ code }: { code: string }) => {
			if (code.includes("broken")) throw new Error("trigger broke");
			return { logs: [] };
		});

		await runTriggeredJobs(
			env,
			ctx,
			"bureau",
			{ id: "event-isolation", kind: "mail.received" },
			execute,
		);
		await settle(waits);

		expect(execute).toHaveBeenCalledTimes(2);
		expect(await getJob(env, "trigger-broken")).toMatchObject({
			lastRunStatus: "error",
			lastRunError: "trigger broke",
		});
		expect(await getJob(env, "trigger-healthy")).toMatchObject({
			lastRunStatus: "success",
		});
	});
});

describe("scheduled job runner", () => {
	it("runs a due job with its stored owner and records success", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(env, job({ id: "due" }));
		const execute = vi.fn(async () => ({ result: "done", logs: ["ran"] }));

		await runDueJobs(env, ctx, execute);
		await settle(waits);

		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({ props, code: expect.stringContaining("due") }),
		);
		expect(await getJob(env, "due")).toMatchObject({
			nextRunAt: "2026-08-20T11:00:00.000Z",
			lastRunStatus: "success",
			runCount: 1,
			successCount: 1,
		});
		expect(await listJobRuns(env, "due")).toEqual([
			expect.objectContaining({ status: "success", source: "schedule" }),
		]);
	});

	it("skips a job that is not due", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(
			env,
			job({ id: "later", nextRunAt: new Date(now + 60_000).toISOString() }),
		);
		const execute = vi.fn();

		await runDueJobs(env, ctx, execute);
		await settle(waits);

		expect(execute).not.toHaveBeenCalled();
		expect(ctx.waitUntil).not.toHaveBeenCalled();
	});

	it("skips a schedule-less triggered job", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(
			env,
			job({
				id: "trigger-only",
				schedule: undefined,
				trigger: { source: "bureau" },
				nextRunAt: null,
			}),
		);
		const execute = vi.fn();

		await runDueJobs(env, ctx, execute);
		await settle(waits);

		expect(execute).not.toHaveBeenCalled();
		expect(ctx.waitUntil).not.toHaveBeenCalled();
	});

	it("does not select an offset-bearing future expiry early", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(
			env,
			job({
				id: "offset-expiry",
				expiresAt: "2026-08-20T08:00:00-04:00",
				nextRunAt: "2026-08-20T11:00:00Z",
			}),
		);
		const execute = vi.fn();

		await runDueJobs(env, ctx, execute);
		await settle(waits);

		expect(execute).not.toHaveBeenCalled();
		expect(await getJob(env, "offset-expiry")).toMatchObject({
			expiresAt: "2026-08-20T12:00:00.000Z",
			nextRunAt: "2026-08-20T11:00:00.000Z",
		});
	});

	it("auto-disables an expired job and records the expiry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx } = createHarness();
		await createJob(
			env,
			job({ id: "expired", expiresAt: new Date(now).toISOString() }),
		);
		const execute = vi.fn();

		await runDueJobs(env, ctx, execute);

		expect(execute).not.toHaveBeenCalled();
		expect(await getJob(env, "expired")).toMatchObject({
			enabled: false,
			nextRunAt: null,
			lastRunStatus: "expired",
			lastRunError: expect.stringContaining("expired"),
			runCount: 1,
		});
		expect(await listJobRuns(env, "expired")).toEqual([
			expect.objectContaining({
				status: "expired",
				source: "schedule",
			}),
		]);
	});

	it("records one throwing job and continues with the others", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(env, job({ id: "broken" }));
		await createJob(env, job({ id: "healthy" }));
		const execute = vi.fn(async ({ code }: { code: string }) => {
			if (code.includes("broken")) throw new Error("sandbox broke");
			return { logs: [] };
		});

		await runDueJobs(env, ctx, execute);
		await settle(waits);

		expect(execute).toHaveBeenCalledTimes(2);
		expect(await getJob(env, "broken")).toMatchObject({
			lastRunStatus: "error",
			lastRunError: "sandbox broke",
			errorCount: 1,
		});
		expect(await listJobRuns(env, "broken")).toEqual([
			expect.objectContaining({ status: "error", error: "sandbox broke" }),
		]);
		expect(await getJob(env, "healthy")).toMatchObject({
			lastRunStatus: "success",
			successCount: 1,
		});
	});

	it("claims atomically across two concurrent ticks", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env } = createHarness();
		await createJob(env, job({ id: "slow" }));
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = vi.fn(async () => {
			await blocked;
			return { logs: [] };
		});
		const firstWaits: Promise<unknown>[] = [];
		const secondWaits: Promise<unknown>[] = [];

		await Promise.all([
			runDueJobs(
				env,
				{ waitUntil: (promise) => firstWaits.push(promise) },
				execute,
			),
			runDueJobs(
				env,
				{ waitUntil: (promise) => secondWaits.push(promise) },
				execute,
			),
		]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(await listJobRuns(env, "slow")).toEqual([
			expect.objectContaining({
				status: "running",
				finishedAt: null,
				durationMs: null,
			}),
		]);

		release();
		await settle([...firstWaits, ...secondWaits]);
		expect(await getJob(env, "slow")).toMatchObject({ runCount: 1 });
		expect(await listJobRuns(env, "slow")).toHaveLength(1);
	});

	it("skips a malformed row without blocking a healthy job", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await createJob(env, job({ id: "malformed" }));
		await createJob(env, job({ id: "healthy" }));
		await env.JOBS_DB.prepare(
			"UPDATE jobs SET schedule_json = '{}' WHERE id = 'malformed'",
		).run();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const execute = vi.fn(async () => ({ logs: [] }));

		await runDueJobs(env, ctx, execute);
		await settle(waits);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({ code: expect.stringContaining("healthy") }),
		);
		expect(consoleError).toHaveBeenCalledWith(
			"ayo malformed job row was skipped",
			expect.objectContaining({ job: "malformed" }),
		);
	});

	it("retains only the newest 50 run records per job", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env } = createHarness();
		await createJob(env, job({ id: "frequent" }));
		const execute = vi.fn(async () => ({ logs: [] }));
		let current = (await getJob(env, "frequent"))!;

		for (let index = 0; index < 55; index += 1) {
			current = (await runJobNow(env, current, execute)).job;
		}

		expect(execute).toHaveBeenCalledTimes(55);
		expect(await getJob(env, "frequent")).toMatchObject({ runCount: 55 });
		expect(await listJobRuns(env, "frequent", 100)).toHaveLength(50);
	});
});
