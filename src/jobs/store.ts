import type { Env, OwnerProps } from "../env";
import type { JobSchedule } from "./schedule";

const RETAINED_RUNS_PER_JOB = 50;
// Bureau does not replay events beyond 30 days, so older claims can be removed.
const EVENT_CLAIM_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type JobRunStatus = "success" | "error" | "expired";
export type JobRunRecordStatus = "running" | JobRunStatus;
export type JobRunSource = "schedule" | "manual";

export type JobTrigger = {
	source: string;
	kind?: string;
};

export type JobRow = {
	id: string;
	name: string;
	code: string;
	schedule?: JobSchedule;
	trigger?: JobTrigger;
	timezone?: string;
	enabled: boolean;
	ownerProps: OwnerProps;
	expiresAt: string | null;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
	lastRunAt: string | null;
	lastRunStatus: JobRunStatus | null;
	lastRunError: string | null;
	lastDurationMs: number | null;
	runCount: number;
	successCount: number;
	errorCount: number;
};

export type JobRunRow = {
	id: string;
	jobId: string;
	startedAt: string;
	finishedAt: string | null;
	status: JobRunRecordStatus;
	error: string | null;
	durationMs: number | null;
	source: JobRunSource;
	eventId: string | null;
};

export type JobClaim = {
	job: JobRow;
	runId: string;
	startedAt: string;
	source: JobRunSource;
};

type StoredJobRow = {
	id: string;
	name: string;
	code: string;
	schedule_json: string;
	trigger_json: string | null;
	timezone: string | null;
	enabled: number;
	owner_props_json: string;
	expires_at: string | null;
	next_run_at: string | null;
	created_at: string;
	updated_at: string;
	last_run_at: string | null;
	last_run_status: JobRunStatus | null;
	last_run_error: string | null;
	last_duration_ms: number | null;
	run_count: number;
	success_count: number;
	error_count: number;
};

type StoredJobRunRow = {
	id: string;
	job_id: string;
	started_at: string;
	finished_at: string | null;
	status: JobRunRecordStatus;
	error: string | null;
	duration_ms: number | null;
	source: JobRunSource;
	event_id: string | null;
};

export function normalizeTimestamp(value: string): string {
	return new Date(value).toISOString();
}

export function normalizeSchedule(schedule: JobSchedule): JobSchedule {
	return schedule.type === "once"
		? { ...schedule, runAt: normalizeTimestamp(schedule.runAt) }
		: schedule;
}

function normalizeJob(job: JobRow): JobRow {
	return {
		...job,
		schedule:
			job.schedule === undefined ? undefined : normalizeSchedule(job.schedule),
		expiresAt:
			job.expiresAt === null ? null : normalizeTimestamp(job.expiresAt),
		nextRunAt:
			job.nextRunAt === null ? null : normalizeTimestamp(job.nextRunAt),
		createdAt: normalizeTimestamp(job.createdAt),
		updatedAt: normalizeTimestamp(job.updatedAt),
		lastRunAt:
			job.lastRunAt === null ? null : normalizeTimestamp(job.lastRunAt),
	};
}

function parseSchedule(serialized: string): JobSchedule | undefined {
	const schedule = JSON.parse(serialized) as Record<string, unknown>;
	if (Object.keys(schedule).length === 0) return undefined;
	if (schedule.type === "once" && typeof schedule.runAt === "string") {
		return normalizeSchedule({ type: "once", runAt: schedule.runAt });
	}
	if (schedule.type === "interval" && typeof schedule.everyMs === "number") {
		return { type: "interval", everyMs: schedule.everyMs };
	}
	if (schedule.type === "cron" && typeof schedule.expression === "string") {
		return { type: "cron", expression: schedule.expression };
	}
	throw new Error("schedule_json does not contain a supported job schedule");
}

function parseTrigger(serialized: string | null): JobTrigger | undefined {
	if (serialized === null) return undefined;
	const trigger = JSON.parse(serialized) as Record<string, unknown>;
	if (
		typeof trigger.source !== "string" ||
		trigger.source.length === 0 ||
		(trigger.kind !== undefined && typeof trigger.kind !== "string")
	) {
		throw new Error("trigger_json does not contain a supported job trigger");
	}
	return {
		source: trigger.source,
		...(trigger.kind === undefined ? {} : { kind: trigger.kind }),
	};
}

function parseOwnerProps(serialized: string): OwnerProps {
	const props = JSON.parse(serialized) as Record<string, unknown>;
	if (
		typeof props.email !== "string" ||
		typeof props.name !== "string" ||
		typeof props.sub !== "string"
	) {
		throw new Error("owner_props_json does not contain valid owner properties");
	}
	return { email: props.email, name: props.name, sub: props.sub };
}

function fromStoredJob(row: StoredJobRow): JobRow {
	const schedule = parseSchedule(row.schedule_json);
	const trigger = parseTrigger(row.trigger_json);
	if (schedule === undefined && trigger === undefined) {
		throw new Error("job has neither a schedule nor a trigger");
	}
	return {
		id: row.id,
		name: row.name,
		code: row.code,
		schedule,
		trigger,
		timezone: row.timezone ?? undefined,
		enabled: row.enabled === 1,
		ownerProps: parseOwnerProps(row.owner_props_json),
		expiresAt:
			row.expires_at === null ? null : normalizeTimestamp(row.expires_at),
		nextRunAt:
			row.next_run_at === null ? null : normalizeTimestamp(row.next_run_at),
		createdAt: normalizeTimestamp(row.created_at),
		updatedAt: normalizeTimestamp(row.updated_at),
		lastRunAt:
			row.last_run_at === null ? null : normalizeTimestamp(row.last_run_at),
		lastRunStatus: row.last_run_status,
		lastRunError: row.last_run_error,
		lastDurationMs: row.last_duration_ms,
		runCount: row.run_count,
		successCount: row.success_count,
		errorCount: row.error_count,
	};
}

function fromStoredRun(row: StoredJobRunRow): JobRunRow {
	return {
		id: row.id,
		jobId: row.job_id,
		startedAt: normalizeTimestamp(row.started_at),
		finishedAt:
			row.finished_at === null ? null : normalizeTimestamp(row.finished_at),
		status: row.status,
		error: row.error,
		durationMs: row.duration_ms,
		source: row.source,
		eventId: row.event_id,
	};
}

function changed(result: D1Result): boolean {
	return (result.meta.changes ?? result.meta.rows_written ?? 0) > 0;
}

function revisionAfter(updatedAt: string, now: number): string {
	const previous = Date.parse(updatedAt);
	return new Date(
		Number.isNaN(previous) ? now : Math.max(now, previous + 1),
	).toISOString();
}

export async function getJob(env: Env, id: string): Promise<JobRow | null> {
	const row = await env.JOBS_DB.prepare("SELECT * FROM jobs WHERE id = ?1")
		.bind(id)
		.first<StoredJobRow>();
	return row === null ? null : fromStoredJob(row);
}

export async function createJob(env: Env, job: JobRow): Promise<void> {
	const normalized = normalizeJob(job);
	await env.JOBS_DB.prepare(
		`INSERT INTO jobs (
			id, name, code, schedule_json, trigger_json, timezone, enabled,
			owner_props_json, expires_at, next_run_at, created_at, updated_at,
			last_run_at, last_run_status, last_run_error, last_duration_ms,
			run_count, success_count, error_count
		) VALUES (
			?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
			?15, ?16, ?17, ?18, ?19
		)`,
	)
		.bind(
			normalized.id,
			normalized.name,
			normalized.code,
			JSON.stringify(normalized.schedule ?? {}),
			normalized.trigger === undefined
				? null
				: JSON.stringify(normalized.trigger),
			normalized.timezone ?? null,
			normalized.enabled ? 1 : 0,
			JSON.stringify(normalized.ownerProps),
			normalized.expiresAt,
			normalized.nextRunAt,
			normalized.createdAt,
			normalized.updatedAt,
			normalized.lastRunAt,
			normalized.lastRunStatus,
			normalized.lastRunError,
			normalized.lastDurationMs,
			normalized.runCount,
			normalized.successCount,
			normalized.errorCount,
		)
		.run();
}

export async function updateJob(
	env: Env,
	job: JobRow,
	expectedUpdatedAt: string,
): Promise<boolean> {
	const normalized = normalizeJob(job);
	const result = await env.JOBS_DB.prepare(
		`UPDATE jobs SET
			name = ?2,
			code = ?3,
			schedule_json = ?4,
			trigger_json = ?5,
			timezone = ?6,
			enabled = ?7,
			expires_at = ?8,
			next_run_at = ?9,
			updated_at = ?10
		WHERE id = ?1 AND updated_at = ?11`,
	)
		.bind(
			normalized.id,
			normalized.name,
			normalized.code,
			JSON.stringify(normalized.schedule ?? {}),
			normalized.trigger === undefined
				? null
				: JSON.stringify(normalized.trigger),
			normalized.timezone ?? null,
			normalized.enabled ? 1 : 0,
			normalized.expiresAt,
			normalized.nextRunAt,
			normalized.updatedAt,
			normalizeTimestamp(expectedUpdatedAt),
		)
		.run();
	return changed(result);
}

export async function deleteJob(env: Env, id: string): Promise<boolean> {
	// Run rows intentionally survive and are D1-console-only after job deletion.
	const result = await env.JOBS_DB.prepare("DELETE FROM jobs WHERE id = ?1")
		.bind(id)
		.run();
	return changed(result);
}

function decodeRows(rows: StoredJobRow[]): JobRow[] {
	const jobs: JobRow[] = [];
	for (const row of rows) {
		try {
			jobs.push(fromStoredJob(row));
		} catch (error) {
			console.error("ayo malformed job row was skipped", {
				job: row.id,
				error,
			});
		}
	}
	return jobs;
}

export async function listJobs(env: Env): Promise<JobRow[]> {
	const { results } = await env.JOBS_DB.prepare(
		"SELECT * FROM jobs ORDER BY created_at, id",
	).all<StoredJobRow>();
	return decodeRows(results);
}

export async function listDueJobs(env: Env, now: string): Promise<JobRow[]> {
	const { results } = await env.JOBS_DB.prepare(
		`SELECT * FROM jobs
		WHERE enabled = 1
			AND next_run_at IS NOT NULL
			AND (
				next_run_at <= ?1
				OR (expires_at IS NOT NULL AND expires_at <= ?1)
			)
		ORDER BY next_run_at, id`,
	)
		.bind(normalizeTimestamp(now))
		.all<StoredJobRow>();
	return decodeRows(results);
}

export async function listTriggeredJobs(
	env: Env,
	now: string,
): Promise<JobRow[]> {
	const { results } = await env.JOBS_DB.prepare(
		`SELECT * FROM jobs
		WHERE enabled = 1
			AND trigger_json IS NOT NULL
			AND (expires_at IS NULL OR expires_at > ?1)
		ORDER BY id`,
	)
		.bind(normalizeTimestamp(now))
		.all<StoredJobRow>();
	return decodeRows(results);
}

export async function pruneEventClaims(env: Env, now: number): Promise<void> {
	const cutoff = new Date(now - EVENT_CLAIM_RETENTION_MS).toISOString();
	await env.JOBS_DB.prepare(
		"DELETE FROM event_claims WHERE claimed_at < ?1",
	)
		.bind(cutoff)
		.run();
}

export async function claimJob(
	env: Env,
	job: JobRow,
	nextRunAt: string | null,
	now: number,
): Promise<JobClaim | null> {
	job = normalizeJob(job);
	nextRunAt = nextRunAt === null ? null : normalizeTimestamp(nextRunAt);
	if (job.nextRunAt === null) return null;
	const startedAt = new Date(now).toISOString();
	const updatedAt = revisionAfter(job.updatedAt, now);
	const runId = `schedule:${job.id}:${job.nextRunAt}`;
	const enabled = job.trigger !== undefined || nextRunAt !== null;
	const [claimResult] = await env.JOBS_DB.batch([
		env.JOBS_DB.prepare(
			`UPDATE jobs SET
				next_run_at = ?2,
				updated_at = ?3,
				enabled = ?6
			WHERE id = ?1 AND next_run_at = ?4 AND enabled = 1
				AND updated_at = ?5`,
		).bind(
			job.id,
			nextRunAt,
			updatedAt,
			job.nextRunAt,
			job.updatedAt,
			enabled ? 1 : 0,
		),
		env.JOBS_DB.prepare(
			`INSERT OR IGNORE INTO job_runs (
				id, job_id, started_at, finished_at, status, error, duration_ms, source
			)
			SELECT ?1, ?2, ?3, NULL, 'running', NULL, NULL, 'schedule'
			WHERE changes() = 1 AND EXISTS (
				SELECT 1 FROM jobs WHERE id = ?2 AND updated_at = ?4
			)`,
		).bind(runId, job.id, startedAt, updatedAt),
		env.JOBS_DB.prepare(
			`DELETE FROM job_runs
			WHERE job_id = ?1 AND id NOT IN (
				SELECT id FROM job_runs
				WHERE job_id = ?1
				ORDER BY started_at DESC, rowid DESC
				LIMIT ?2
			)`,
		).bind(job.id, RETAINED_RUNS_PER_JOB),
	]);
	if (!changed(claimResult)) return null;
	return {
		job: { ...job, nextRunAt, enabled, updatedAt },
		runId,
		startedAt,
		source: "schedule",
	};
}

export async function claimManualRun(
	env: Env,
	job: JobRow,
	nextRunAt: string | null,
	now: number,
): Promise<JobClaim | null> {
	job = normalizeJob(job);
	nextRunAt = nextRunAt === null ? null : normalizeTimestamp(nextRunAt);
	const startedAt = new Date(now).toISOString();
	const updatedAt = revisionAfter(job.updatedAt, now);
	const enabled =
		job.enabled && (job.trigger !== undefined || nextRunAt !== null);
	const runId = `manual:${job.id}:${job.updatedAt}`;
	const [claimResult] = await env.JOBS_DB.batch([
		env.JOBS_DB.prepare(
			`UPDATE jobs SET next_run_at = ?2, enabled = ?3, updated_at = ?4
			WHERE id = ?1 AND updated_at = ?5`,
		).bind(job.id, nextRunAt, enabled ? 1 : 0, updatedAt, job.updatedAt),
		env.JOBS_DB.prepare(
			`INSERT OR IGNORE INTO job_runs (
				id, job_id, started_at, finished_at, status, error, duration_ms, source
			)
			SELECT ?1, ?2, ?3, NULL, 'running', NULL, NULL, 'manual'
			WHERE changes() = 1 AND EXISTS (
				SELECT 1 FROM jobs WHERE id = ?2 AND updated_at = ?4
			)`,
		).bind(runId, job.id, startedAt, updatedAt),
		env.JOBS_DB.prepare(
			`DELETE FROM job_runs
			WHERE job_id = ?1 AND id NOT IN (
				SELECT id FROM job_runs
				WHERE job_id = ?1
				ORDER BY started_at DESC, rowid DESC
				LIMIT ?2
			)`,
		).bind(job.id, RETAINED_RUNS_PER_JOB),
	]);
	if (!changed(claimResult)) return null;
	return {
		job: { ...job, nextRunAt, enabled, updatedAt },
		runId,
		startedAt,
		source: "manual",
	};
}

export async function claimTriggeredRun(
	env: Env,
	job: JobRow,
	eventId: string,
	now: number,
): Promise<JobClaim | null> {
	job = normalizeJob(job);
	if (job.trigger === undefined) return null;
	const startedAt = new Date(now).toISOString();
	const runId = `trigger:${crypto.randomUUID()}`;
	const [claimResult] = await env.JOBS_DB.batch([
		env.JOBS_DB.prepare(
			`INSERT OR IGNORE INTO event_claims (job_id, event_id, claimed_at)
			SELECT ?1, ?2, ?3
			WHERE EXISTS (
				SELECT 1 FROM jobs
				WHERE id = ?1
					AND enabled = 1
					AND trigger_json = ?4
					AND (expires_at IS NULL OR expires_at > ?3)
					AND updated_at = ?5
			)`,
		).bind(
			job.id,
			eventId,
			startedAt,
			JSON.stringify(job.trigger),
			job.updatedAt,
		),
		env.JOBS_DB.prepare(
			`INSERT INTO job_runs (
				id, job_id, started_at, finished_at, status, error, duration_ms,
				source, event_id
			)
			SELECT ?1, ?2, ?3, NULL, 'running', NULL, NULL, 'schedule', ?4
			WHERE changes() = 1 AND EXISTS (
				SELECT 1 FROM event_claims
				WHERE job_id = ?2 AND event_id = ?4 AND claimed_at = ?3
			)`,
		).bind(runId, job.id, startedAt, eventId),
		env.JOBS_DB.prepare(
			`DELETE FROM job_runs
			WHERE job_id = ?1 AND id NOT IN (
				SELECT id FROM job_runs
				WHERE job_id = ?1
					ORDER BY started_at DESC, rowid DESC
					LIMIT ?2
			)`,
		).bind(job.id, RETAINED_RUNS_PER_JOB),
	]);
	if (!changed(claimResult)) {
		const state = await env.JOBS_DB.prepare(
			`SELECT
				EXISTS (
					SELECT 1 FROM event_claims
					WHERE job_id = ?1 AND event_id = ?2
				) AS claimed,
				EXISTS (
					SELECT 1 FROM jobs
					WHERE id = ?1
						AND enabled = 1
						AND trigger_json = ?3
						AND (expires_at IS NULL OR expires_at > ?4)
				) AS eligible`,
		)
			.bind(job.id, eventId, JSON.stringify(job.trigger), startedAt)
			.first<{ claimed: number; eligible: number }>();
		if (state?.claimed === 1) return null;
		if (state?.eligible === 1) {
			throw new Error(`Job ${job.id} changed before the event could be claimed.`);
		}
		return null;
	}
	return { job, runId, startedAt, source: "schedule" };
}

export async function disableJob(
	env: Env,
	job: JobRow,
	input: {
		status: "error" | "expired";
		error: string;
		now: number;
		source: JobRunSource;
	},
): Promise<JobRow | null> {
	job = normalizeJob(job);
	const at = new Date(input.now).toISOString();
	const updatedAt = revisionAfter(job.updatedAt, input.now);
	const runId = `${input.status}:${input.source}:${job.id}:${job.updatedAt}`;
	const errorIncrement = input.status === "error" ? 1 : 0;
	const [updateResult] = await env.JOBS_DB.batch([
		env.JOBS_DB.prepare(
			`UPDATE jobs SET
				enabled = 0,
				next_run_at = NULL,
				updated_at = ?2,
				last_run_at = ?3,
				last_run_status = ?4,
				last_run_error = ?5,
				last_duration_ms = 0,
				run_count = run_count + 1,
				error_count = error_count + ?6
			WHERE id = ?1 AND enabled = 1 AND updated_at = ?7`,
		).bind(
			job.id,
			updatedAt,
			at,
			input.status,
			input.error,
			errorIncrement,
			job.updatedAt,
		),
		env.JOBS_DB.prepare(
			`INSERT OR IGNORE INTO job_runs (
				id, job_id, started_at, finished_at, status, error, duration_ms, source
			)
			SELECT ?1, ?2, ?3, ?3, ?4, ?5, 0, ?6
			WHERE changes() = 1 AND EXISTS (
				SELECT 1 FROM jobs
				WHERE id = ?2 AND enabled = 0 AND updated_at = ?7
			)`,
		).bind(
			runId,
			job.id,
			at,
			input.status,
			input.error,
			input.source,
			updatedAt,
		),
		env.JOBS_DB.prepare(
			`DELETE FROM job_runs
			WHERE job_id = ?1 AND id NOT IN (
				SELECT id FROM job_runs
				WHERE job_id = ?1
				ORDER BY started_at DESC, rowid DESC
				LIMIT ?2
			)`,
		).bind(job.id, RETAINED_RUNS_PER_JOB),
	]);
	return changed(updateResult) ? getJob(env, job.id) : null;
}

export async function finalizeJobRun(
	env: Env,
	run: {
		id: string;
		jobId: string;
		startedAt: string;
		finishedAt: string;
		status: "success" | "error";
		error: string | null;
		durationMs: number;
	},
): Promise<JobRow | null> {
	const startedAt = normalizeTimestamp(run.startedAt);
	const finishedAt = normalizeTimestamp(run.finishedAt);
	const successIncrement = run.status === "success" ? 1 : 0;
	const errorIncrement = run.status === "error" ? 1 : 0;
	const [, finalizeResult] = await env.JOBS_DB.batch([
		env.JOBS_DB.prepare(
			`UPDATE jobs SET
				last_run_at = ?2,
				last_run_status = ?3,
				last_run_error = ?4,
				last_duration_ms = ?5,
				run_count = run_count + 1,
				success_count = success_count + ?6,
				error_count = error_count + ?7,
				updated_at = strftime(
					'%Y-%m-%dT%H:%M:%fZ',
					MAX(julianday(updated_at) + 1.0 / 86400000, julianday(?8))
				)
			WHERE id = ?1 AND EXISTS (
				SELECT 1 FROM job_runs WHERE id = ?9 AND status = 'running'
			)`,
		).bind(
			run.jobId,
			startedAt,
			run.status,
			run.error,
			run.durationMs,
			successIncrement,
			errorIncrement,
			finishedAt,
			run.id,
		),
		env.JOBS_DB.prepare(
			`UPDATE job_runs SET
				finished_at = ?2,
				status = ?3,
				error = ?4,
				duration_ms = ?5
			WHERE id = ?1 AND status = 'running'`,
		).bind(run.id, finishedAt, run.status, run.error, run.durationMs),
	]);
	if (!changed(finalizeResult)) {
		throw new Error(`Running record ${run.id} could not be finalized.`);
	}
	return getJob(env, run.jobId);
}

export async function listJobRuns(
	env: Env,
	jobId: string,
	limit = 10,
): Promise<JobRunRow[]> {
	const { results } = await env.JOBS_DB.prepare(
		`SELECT * FROM job_runs
		WHERE job_id = ?1
		ORDER BY started_at DESC, rowid DESC
		LIMIT ?2`,
	)
		.bind(jobId, limit)
		.all<StoredJobRunRow>();
	return results.map(fromStoredRun);
}
