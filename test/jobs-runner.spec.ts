import { env as bindings } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, OwnerProps } from "../src/env";
import { runDueJobs, runJobNow } from "../src/jobs/runner";
import {
	createJob,
	getJob,
	listJobRuns,
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
