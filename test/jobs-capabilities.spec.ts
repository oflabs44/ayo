import { env as bindings } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobs } from "../src/capabilities/jobs";
import type { Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

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

async function createConfirmed(
	dispatch: ReturnType<typeof buildDispatchTable>,
) {
	const staged = (await dispatch.job_create!(createInput)) as {
		confirmId: string;
	};
	return dispatch.job_create!({ confirmId: staged.confirmId }) as Promise<{
		created: boolean;
		job: { id: string };
	}>;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("job capabilities", () => {
	it("stages the real default expiry and creates only after confirmation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();

		const staged = (await dispatch.job_create!(createInput)) as {
			confirmId: string;
			created: boolean;
			preview: Record<string, unknown>;
		};
		expect(staged.created).toBe(false);
		expect(staged.preview).toMatchObject({
			...createInput,
			expiresAt: "2026-09-19T10:00:00.000Z",
		});
		expect(staged.preview).not.toHaveProperty("id");

		const confirmed = (await dispatch.job_create!({
			confirmId: staged.confirmId,
		})) as { created: boolean; job: Record<string, unknown> };
		expect(confirmed).toMatchObject({
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

	it("normalizes offset timestamps before staging and storage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const staged = (await dispatch.job_create!({
			...createInput,
			schedule: {
				type: "once",
				runAt: "2026-08-20T09:30:00-04:00",
			},
			expiresAt: "2026-08-20T10:00:00-04:00",
		})) as {
			confirmId: string;
			preview: {
				schedule: { type: "once"; runAt: string };
				expiresAt: string;
			};
		};

		expect(staged.preview).toMatchObject({
			schedule: { type: "once", runAt: "2026-08-20T13:30:00.000Z" },
			expiresAt: "2026-08-20T14:00:00.000Z",
		});
		await expect(
			dispatch.job_create!({ confirmId: staged.confirmId }),
		).resolves.toMatchObject({
			job: {
				schedule: { runAt: "2026-08-20T13:30:00.000Z" },
				expiresAt: "2026-08-20T14:00:00.000Z",
				nextRunAt: "2026-08-20T13:30:00.000Z",
			},
		});
	});

	it("allows a null expiry and refuses a reused create confirmation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const staged = (await dispatch.job_create!({
			...createInput,
			expiresAt: null,
		})) as { confirmId: string; preview: { expiresAt: string | null } };
		expect(staged.preview.expiresAt).toBeNull();
		await dispatch.job_create!({ confirmId: staged.confirmId });

		const reused = (await dispatch.job_create!({
			confirmId: staged.confirmId,
		})) as { created: boolean; error: string };
		expect(reused.created).toBe(false);
		expect(reused.error).toContain("unknown or expired");
	});

	it("previews a merged update and applies it after confirmation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const created = await createConfirmed(dispatch);

		const staged = (await dispatch.job_update!({
			id: created.job.id,
			enabled: false,
			name: "Paused brief",
		})) as {
			confirmId: string;
			updated: boolean;
			preview: Record<string, unknown>;
		};
		expect(staged.updated).toBe(false);
		expect(staged.preview).toMatchObject({
			id: created.job.id,
			name: "Paused brief",
			enabled: false,
			code: createInput.code,
			schedule: createInput.schedule,
		});

		await expect(
			dispatch.job_update!({ confirmId: staged.confirmId }),
		).resolves.toMatchObject({
			updated: true,
			job: { id: created.job.id, name: "Paused brief", enabled: false },
		});
		const reused = (await dispatch.job_update!({
			confirmId: staged.confirmId,
		})) as { updated: boolean; error: string };
		expect(reused.updated).toBe(false);
		expect(reused.error).toContain("unknown or expired");
	});

	it("refuses an update confirmation after a concurrent change", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const created = await createConfirmed(dispatch);
		const stale = (await dispatch.job_update!({
			id: created.job.id,
			name: "Stale preview",
		})) as { confirmId: string };
		const concurrent = (await dispatch.job_update!({
			id: created.job.id,
			enabled: false,
		})) as { confirmId: string };
		await dispatch.job_update!({ confirmId: concurrent.confirmId });

		await expect(
			dispatch.job_update!({ confirmId: stale.confirmId }),
		).resolves.toMatchObject({
			updated: false,
			error: expect.stringContaining("changed or was deleted"),
		});
		await expect(dispatch.job_read!({ id: created.job.id })).resolves.toMatchObject(
			{ name: "Daily brief", enabled: false },
		);
	});

	it("recomputes nextRunAt when a confirmed schedule changes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const created = await createConfirmed(dispatch);
		const staged = (await dispatch.job_update!({
			id: created.job.id,
			schedule: { type: "interval", everyMs: 3_600_000 },
		})) as { confirmId: string; preview: { nextRunAt: string } };
		expect(staged.preview.nextRunAt).toBe("2026-08-20T11:00:00.000Z");

		const result = (await dispatch.job_update!({
			confirmId: staged.confirmId,
		})) as { job: { nextRunAt: string } };
		expect(result.job.nextRunAt).toBe("2026-08-20T11:00:00.000Z");
	});

	it("lists compact jobs, reads the full row, and deletes directly", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { dispatch } = createHarness();
		const created = await createConfirmed(dispatch);

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
		const created = await createConfirmed(dispatch);

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
