import { z } from "zod";
import {
	burnConfirmation,
	readConfirmation,
	stageConfirmation,
} from "../confirm";
import type { Env, OwnerProps } from "../env";
import { runJobNow } from "../jobs/runner";
import {
	describeSchedule,
	MIN_INTERVAL_MS,
	nextRunAt,
	type JobSchedule,
} from "../jobs/schedule";
import {
	createJob,
	deleteJob,
	getJob,
	listJobRuns,
	listJobs,
	normalizeSchedule,
	normalizeTimestamp,
	updateJob,
	type JobRow,
	type JobTrigger,
} from "../jobs/store";
import type { Capability } from "./index";

const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60_000;
const confirmSchema = z.object({ confirmId: z.string().min(1) });
const jobIdSchema = z.object({ id: z.uuid() });
const codeSchema = z
	.string()
	.min(1)
	.max(20_000)
	.describe(
		"The same script shape as execute: a module that default-exports a function, with ayo.* capabilities in scope, no imports, and no network access.",
	);
const scheduleSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("once"),
		runAt: z.iso
			.datetime({ offset: true })
			.describe("ISO 8601 timestamp for the single run."),
	}),
	z.object({
		type: z.literal("interval"),
		everyMs: z
			.number()
			.int()
			.min(MIN_INTERVAL_MS)
			.describe("Milliseconds between runs; one minute is the floor."),
	}),
	z.object({
		type: z.literal("cron"),
		expression: z
			.string()
			.min(1)
			.describe(
				'Five fields: minute hour day-of-month month day-of-week, for example "0 8 * * *".',
			),
	}),
]);
const triggerSchema = z.object({
	source: z.string().min(1),
	kind: z.string().optional(),
});
const expiresAtSchema = z.iso.datetime({ offset: true }).nullable();
const createPayloadSchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		code: codeSchema,
		schedule: scheduleSchema.optional(),
		trigger: triggerSchema.optional(),
		timezone: z.string().min(1).default("UTC"),
		expiresAt: expiresAtSchema.optional(),
	})
	.refine(({ schedule, trigger }) => schedule !== undefined || trigger !== undefined, {
		message: "A job requires a schedule, a trigger, or both.",
	});
const createJobSchema = z.union([createPayloadSchema, confirmSchema]);
const jobChangeShape = {
	name: z.string().trim().min(1).max(80).optional(),
	code: codeSchema.optional(),
	schedule: scheduleSchema.optional(),
	trigger: triggerSchema.optional(),
	timezone: z.string().min(1).optional(),
	enabled: z.boolean().optional(),
	expiresAt: expiresAtSchema.optional(),
};
function hasJobChange(input: Record<string, unknown>): boolean {
	return Object.values(input).some((value) => value !== undefined);
}
const updatePayloadSchema = z
	.object({ id: z.uuid(), ...jobChangeShape })
	.refine(
		({ id: _id, ...changes }) => hasJobChange(changes),
		{ message: "At least one field to update is required." },
	);
const updateJobSchema = z.union([updatePayloadSchema, confirmSchema]);
const ownerPropsSchema = z.object({
	email: z.string(),
	name: z.string(),
	sub: z.string(),
});
const jobRowSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	code: z.string(),
	schedule: scheduleSchema.optional(),
	trigger: triggerSchema.optional(),
	timezone: z.string().optional(),
	enabled: z.boolean(),
	ownerProps: ownerPropsSchema,
	expiresAt: z.string().nullable(),
	nextRunAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	lastRunAt: z.string().nullable(),
	lastRunStatus: z.enum(["success", "error", "expired"]).nullable(),
	lastRunError: z.string().nullable(),
	lastDurationMs: z.number().nullable(),
	runCount: z.number().int(),
	successCount: z.number().int(),
	errorCount: z.number().int(),
});
const stagedUpdateSchema = z.object({
	job: jobRowSchema,
	expectedUpdatedAt: z.string(),
});

type CreatePayload = z.infer<typeof createPayloadSchema>;
type UpdatePayload = z.infer<typeof updatePayloadSchema>;
type JobChanges = Omit<UpdatePayload, "id">;

function noJob(id: string): Error {
	return new Error(`No job "${id}". Use job_list to see what exists.`);
}

function nextFor(
	schedule: JobSchedule,
	timezone: string,
	after: number,
): string {
	const next = nextRunAt({ schedule, timezone, after });
	if (next === null) {
		throw new Error(
			"That schedule has no next run. A one-off in the past cannot be scheduled.",
		);
	}
	return new Date(next).toISOString();
}

function newJob(
	payload: CreatePayload & { expiresAt: string | null },
	props: OwnerProps,
	now: number,
): JobRow {
	const timestamp = new Date(now).toISOString();
	const schedule =
		payload.schedule === undefined
			? undefined
			: normalizeSchedule(payload.schedule);
	return {
		id: crypto.randomUUID(),
		name: payload.name,
		code: payload.code,
		schedule,
		trigger: payload.trigger,
		timezone: payload.timezone,
		enabled: true,
		ownerProps: { ...props },
		expiresAt:
			payload.expiresAt === null
				? null
				: normalizeTimestamp(payload.expiresAt),
		nextRunAt:
			schedule === undefined ? null : nextFor(schedule, payload.timezone, now),
		createdAt: timestamp,
		updatedAt: timestamp,
		lastRunAt: null,
		lastRunStatus: null,
		lastRunError: null,
		lastDurationMs: null,
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	};
}

function revisionAfter(updatedAt: string, now: number): string {
	const previous = Date.parse(updatedAt);
	return new Date(
		Number.isNaN(previous) ? now : Math.max(now, previous + 1),
	).toISOString();
}

function mergeJob(job: JobRow, changes: JobChanges, now: number): JobRow {
	const schedule =
		changes.schedule === undefined
			? job.schedule
			: normalizeSchedule(changes.schedule);
	const trigger: JobTrigger | undefined = changes.trigger ?? job.trigger;
	if (schedule === undefined && trigger === undefined) {
		throw new Error("A job requires a schedule, a trigger, or both.");
	}
	const timezone = changes.timezone ?? job.timezone ?? "UTC";
	const scheduleChanged =
		changes.schedule !== undefined ||
		(changes.timezone !== undefined && schedule?.type === "cron");
	const expiresAt =
		changes.expiresAt === undefined
			? job.expiresAt
			: changes.expiresAt === null
				? null
				: normalizeTimestamp(changes.expiresAt);
	let nextRunAt = job.nextRunAt;
	if (scheduleChanged) {
		nextRunAt =
			schedule === undefined ? null : nextFor(schedule, timezone, now);
	}
	return {
		...job,
		...changes,
		schedule,
		trigger,
		timezone,
		expiresAt,
		nextRunAt,
		updatedAt: revisionAfter(job.updatedAt, now),
	};
}

function createPreview(payload: CreatePayload, now: number) {
	const schedule =
		payload.schedule === undefined
			? undefined
			: normalizeSchedule(payload.schedule);
	const expiresAt =
		payload.expiresAt === undefined
			? new Date(now + DEFAULT_EXPIRY_MS).toISOString()
			: payload.expiresAt === null
				? null
				: normalizeTimestamp(payload.expiresAt);
	// Compute once during staging so malformed or exhausted schedules never get
	// as far as a confirmation token.
	if (schedule !== undefined) nextFor(schedule, payload.timezone, now);
	return schedule === undefined
		? { ...payload, expiresAt }
		: { ...payload, schedule, expiresAt };
}

function compactJob(job: JobRow) {
	return {
		id: job.id,
		name: job.name,
		scheduleSummary:
			job.schedule === undefined
				? null
				: describeSchedule(job.schedule, job.timezone),
		trigger: job.trigger,
		enabled: job.enabled,
		nextRunAt: job.nextRunAt,
		lastRunStatus: job.lastRunStatus,
		runCount: job.runCount,
	};
}

async function confirmedCreate(
	env: Env,
	props: OwnerProps,
	confirmId: string,
) {
	const staged = await readConfirmation(env, "job_create", confirmId);
	if (!staged) {
		return {
			created: false,
			error: `Confirmation ${confirmId} is unknown or expired. Stage the job again.`,
		};
	}
	const payload = createPayloadSchema
		.required({ expiresAt: true })
		.parse(JSON.parse(staged));
	const job = newJob(payload, props, Date.now());
	await createJob(env, job);
	await burnConfirmation(env, "job_create", confirmId);
	return { created: true, job };
}

async function confirmedUpdate(env: Env, confirmId: string) {
	const staged = await readConfirmation(env, "job_update", confirmId);
	if (!staged) {
		return {
			updated: false,
			error: `Confirmation ${confirmId} is unknown or expired. Stage the update again.`,
		};
	}
	const { job, expectedUpdatedAt } = stagedUpdateSchema.parse(
		JSON.parse(staged),
	);
	const current = await getJob(env, job.id);
	if (!current || current.updatedAt !== expectedUpdatedAt) {
		await burnConfirmation(env, "job_update", confirmId);
		return {
			updated: false,
			error:
				"The job changed or was deleted after this update was staged. Read it and stage the update again.",
		};
	}
	if (!(await updateJob(env, job, expectedUpdatedAt))) {
		await burnConfirmation(env, "job_update", confirmId);
		return {
			updated: false,
			error:
				"The job changed or was deleted while this update was confirmed. Read it and stage the update again.",
		};
	}
	await burnConfirmation(env, "job_update", confirmId);
	return { updated: true, job };
}

export const jobs: Capability[] = [
	{
		name: "job_create",
		description:
			"Create unattended automation on a schedule or in reaction to an event—for example: when an email arrives, tag it. The automation can call ayo.* capabilities. Confirm-before-act: the first call returns the automation, schedule or trigger, and real expiry as a preview plus confirmId; after approval, call again with only confirmId",
		inputSchema: createJobSchema,
		keywords: [
			"run every morning at 8",
			"schedule unattended script",
			"create recurring automation",
			"cron job",
			"run later without a host",
			"when an email arrives",
			"when new mail comes in",
			"event triggered job",
		],
		handler: async (rawInput, { env, props }) => {
			const input = rawInput as z.infer<typeof createJobSchema>;
			if ("confirmId" in input) {
				return confirmedCreate(env, props, input.confirmId);
			}
			const preview = createPreview(input, Date.now());
			const confirmId = await stageConfirmation(env, "job_create", preview);
			return { confirmId, preview, created: false };
		},
	},
	{
		name: "job_list",
		description:
			"List unattended scheduled and event-triggered jobs, including whether each is enabled, its schedule or trigger, next run, last status, and run count",
		inputSchema: z.object({}),
		keywords: [
			"what jobs are scheduled",
			"list scheduled automations",
			"show recurring scripts",
		],
		handler: async (_input, { env }) => ({
			jobs: (await listJobs(env)).map(compactJob),
		}),
	},
	{
		name: "job_read",
		description:
			"Read one unattended job in full, including its script, owner properties, schedule or event trigger, expiry, run counters, and ten most recent run records",
		inputSchema: jobIdSchema,
		keywords: [
			"inspect scheduled job",
			"show job code",
			"why did this job fail",
			"job run statistics",
		],
		handler: async (rawInput, { env }) => {
			const { id } = rawInput as z.infer<typeof jobIdSchema>;
			const job = await getJob(env, id);
			if (!job) throw noJob(id);
			return { ...job, recentRuns: await listJobRuns(env, id, 10) };
		},
	},
	{
		name: "job_update",
		description:
			"Change the schedule or trigger for this automation, or pause, resume, and edit it. Confirm-before-act: the first call previews the merged job plus confirmId; after approval, call again with only confirmId",
		inputSchema: updateJobSchema,
		keywords: [
			"pause that job",
			"disable scheduled automation",
			"resume recurring job",
			"change job schedule",
			"edit job script",
		],
		handler: async (rawInput, { env }) => {
			const input = rawInput as z.infer<typeof updateJobSchema>;
			if ("confirmId" in input) {
				return confirmedUpdate(env, input.confirmId);
			}
			const { id, ...changes } = input;
			const current = await getJob(env, id);
			if (!current) throw noJob(id);
			const preview = mergeJob(current, changes, Date.now());
			const confirmId = await stageConfirmation(env, "job_update", {
				job: preview,
				expectedUpdatedAt: current.updatedAt,
			});
			return { confirmId, preview, updated: false };
		},
	},
	{
		name: "job_delete",
		description:
			"Remove this scheduled or event-triggered automation so its unattended script cannot run again",
		inputSchema: jobIdSchema,
		keywords: [
			"delete the daily brief job",
			"remove scheduled automation",
			"cancel recurring script",
			"unschedule job",
		],
		handler: async (rawInput, { env }) => {
			// Removing a standing grant is the safe direction, so deletion is direct.
			const { id } = rawInput as z.infer<typeof jobIdSchema>;
			return { deleted: await deleteJob(env, id) };
		},
	},
	{
		name: "job_run_now",
		description:
			"Run a stored job immediately instead of waiting for its schedule, record the result, and advance its next scheduled run",
		inputSchema: jobIdSchema,
		keywords: [
			"run the job now",
			"execute scheduled script immediately",
			"test job manually",
			"fire job manually",
		],
		handler: async (rawInput, { env }) => {
			const { id } = rawInput as z.infer<typeof jobIdSchema>;
			const job = await getJob(env, id);
			if (!job) throw noJob(id);
			const run = await runJobNow(env, job);
			return {
				status: run.status,
				durationMs: run.durationMs,
				result: run.result ?? null,
				logs: run.logs,
				error: run.error ?? null,
				nextRunAt: run.job.nextRunAt,
				enabled: run.job.enabled,
			};
		},
	},
];
