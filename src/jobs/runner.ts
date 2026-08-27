import type { Env, OwnerProps } from "../env";
import type { ExecuteOutcome } from "../execute";
import { nextRunAt } from "./schedule";
import {
	claimJob,
	claimManualRun,
	disableJob,
	finalizeJobRun,
	listDueJobs,
	type JobClaim,
	type JobRow,
	type JobRunSource,
} from "./store";

type JobExecutionInput = {
	code: string;
	env: Env;
	props: OwnerProps;
};

type ExecuteJobCode = (input: JobExecutionInput) => Promise<ExecuteOutcome>;

type JobExecutionContext = {
	waitUntil(promise: Promise<unknown>): void;
};

async function defaultExecute(
	input: JobExecutionInput,
): Promise<ExecuteOutcome> {
	const { executeCode } = await import("../execute");
	return executeCode(input);
}

export type JobRunResult = ExecuteOutcome & {
	status: "success" | "error";
	durationMs: number;
	job: JobRow;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function nextForRun(job: JobRow, now: number): string | null {
	const next = nextRunAt({
		schedule: job.schedule,
		timezone: job.timezone,
		after: now,
	});
	return next === null ? null : new Date(next).toISOString();
}

async function executeAndRecord(
	env: Env,
	claim: JobClaim,
	execute: ExecuteJobCode,
): Promise<JobRunResult> {
	let outcome: ExecuteOutcome;
	try {
		outcome = await execute({
			code: claim.job.code,
			env,
			props: claim.job.ownerProps,
		});
	} catch (error) {
		outcome = { logs: [], error: errorMessage(error) };
	}

	const finishedAt = Date.now();
	const status = outcome.error === undefined ? "success" : "error";
	const durationMs = Math.max(0, finishedAt - Date.parse(claim.startedAt));
	const job =
		(await finalizeJobRun(env, {
			id: claim.runId,
			jobId: claim.job.id,
			startedAt: claim.startedAt,
			finishedAt: new Date(finishedAt).toISOString(),
			status,
			error: outcome.error ?? null,
			durationMs,
		})) ?? claim.job;

	return { ...outcome, status, durationMs, job };
}

async function expire(
	env: Env,
	job: JobRow,
	now: number,
	source: JobRunSource,
): Promise<{ job: JobRow; error: string } | null> {
	const error = `Job expired at ${job.expiresAt} and was disabled.`;
	const disabled = await disableJob(env, job, {
		status: "expired",
		error,
		now,
		source,
	});
	return disabled === null ? null : { job: disabled, error };
}

async function disableUnusableSchedule(
	env: Env,
	job: JobRow,
	now: number,
	error: unknown,
): Promise<void> {
	const message = `Job was disabled because its schedule is unusable: ${errorMessage(error)}`;
	await disableJob(env, job, {
		status: "error",
		error: message,
		now,
		source: "schedule",
	});
}

export async function runDueJobs(
	env: Env,
	ctx: JobExecutionContext,
	execute: ExecuteJobCode = defaultExecute,
): Promise<void> {
	const now = Date.now();
	const runs: Array<Promise<void>> = [];

	for (const job of await listDueJobs(env, new Date(now).toISOString())) {
		if (job.expiresAt !== null && Date.parse(job.expiresAt) <= now) {
			try {
				await expire(env, job, now, "schedule");
			} catch (error) {
				console.error("ayo expired job could not be disabled", {
					job: job.id,
					error,
				});
			}
			continue;
		}

		let next: string | null;
		try {
			next = nextForRun(job, now);
		} catch (error) {
			try {
				await disableUnusableSchedule(env, job, now, error);
			} catch (disableError) {
				console.error("ayo unusable job could not be disabled", {
					job: job.id,
					error: disableError,
				});
			}
			continue;
		}

		try {
			const claimed = await claimJob(env, job, next, now);
			if (claimed === null) continue;
			runs.push(
				executeAndRecord(env, claimed, execute).then(
					() => undefined,
					(error: unknown) => {
						console.error("ayo job run could not be recorded", {
							job: job.id,
							error,
						});
					},
				),
			);
		} catch (error) {
			console.error("ayo job could not be claimed", { job: job.id, error });
		}
	}

	if (runs.length > 0) ctx.waitUntil(Promise.all(runs).then(() => undefined));
}

export async function runJobNow(
	env: Env,
	job: JobRow,
	execute: ExecuteJobCode = defaultExecute,
): Promise<JobRunResult> {
	const now = Date.now();
	if (job.expiresAt !== null && Date.parse(job.expiresAt) <= now) {
		const expired = await expire(env, job, now, "manual");
		if (expired === null) {
			throw new Error(
				"The job changed before it could be marked expired. Read it and try again.",
			);
		}
		return {
			logs: [],
			error: expired.error,
			status: "error",
			durationMs: 0,
			job: expired.job,
		};
	}

	const next = nextForRun(job, now);
	const claimed = await claimManualRun(env, job, next, now);
	if (claimed === null) {
		throw new Error("The job changed before it could run. Read it and try again.");
	}
	return executeAndRecord(env, claimed, execute);
}
