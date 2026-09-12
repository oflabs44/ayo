import { z } from "zod";
import type { Capability } from "./index";

const BACKEND_NOT_CONFIGURED = "The tasks backend is not configured.";

const accountSchema = z.object({ address: z.email() });
const resourceSchema = accountSchema.extend({ id: z.uuid() });
const calendarDateTimeSchema = z.iso.datetime({ offset: true });
const calendarTimeSchema = z.union([z.iso.date(), calendarDateTimeSchema]);
// A due date alone never notifies; only a VALARM makes iOS Reminders fire.
const alarmSchema = z.object({
	trigger: z.string().min(1),
	action: z.enum(["DISPLAY", "EMAIL", "AUDIO"]).optional(),
	related: z.enum(["START", "END"]).optional(),
	description: z.string().optional(),
});
const listTasksSchema = accountSchema.extend({
	calendar: z.uuid().optional(),
	status: z.string().min(1).optional(),
	dueBefore: calendarTimeSchema.optional(),
});
const taskCreateBodySchema = z
	.object({
		calendar: z.uuid(),
		summary: z.string().min(1),
		start: calendarTimeSchema
			.optional()
			.describe("Required when rrule is set"),
		due: calendarTimeSchema.optional(),
		description: z.string().optional(),
		priority: z.int().min(0).max(9).optional(),
		status: z.string().min(1).optional(),
		rrule: z.string().min(1).optional(),
		alarms: z.array(alarmSchema).optional(),
	})
	.superRefine((input, context) => {
		if (input.rrule !== undefined && input.start === undefined) {
			context.addIssue({
				code: "custom",
				message: "Recurring tasks require a start date or date-time",
			});
		}
		if (
			input.alarms?.some((alarm) => alarm.related === "END") &&
			input.due === undefined
		) {
			context.addIssue({
				code: "custom",
				message: "Task alarms related to END require a due date or date-time",
			});
		}
	});
const createTaskSchema = taskCreateBodySchema.safeExtend(accountSchema.shape);
const taskUpdateBodySchema = z
	.object({
		status: z.string().min(1).optional(),
		start: calendarTimeSchema.nullable().optional(),
		due: calendarTimeSchema.nullable().optional(),
		summary: z.string().min(1).nullable().optional(),
		description: z.string().nullable().optional(),
		priority: z.int().min(0).max(9).nullable().optional(),
		rrule: z.string().min(1).nullable().optional(),
		alarms: z.array(alarmSchema).nullable().optional(),
	})
	.refine(
		(input) =>
			input.status !== undefined ||
			input.start !== undefined ||
			input.due !== undefined ||
			input.summary !== undefined ||
			input.description !== undefined ||
			input.priority !== undefined ||
			input.rrule !== undefined ||
			input.alarms !== undefined,
		{ message: "At least one todo field is required" },
	);
const updateTaskSchema = taskUpdateBodySchema.safeExtend({
	...resourceSchema.shape,
	etag: z.string().min(1).optional(),
});
const deleteTaskSchema = resourceSchema.extend({
	etag: z.string().min(1).optional(),
});

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

export const tasks: Capability[] = [
	{
		name: "task_list",
		description:
			"List tasks with each row's status and completed timestamp, optionally filtered by calendar, status, or due before a date; without a status filter, all statuses are returned",
		inputSchema: listTasksSchema,
		keywords: [
			"list tasks",
			"tasks due this week",
			"overdue tasks",
			"what is on my plate",
			"open todos",
			"completed tasks",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.listTodos(input as z.infer<typeof listTasksSchema>);
		},
	},
	{
		name: "task_read",
		description:
			"Open one task or todo item and get its full details, including the ETag callers need to update safely",
		inputSchema: resourceSchema,
		keywords: [
			"read task",
			"open todo",
			"task details",
			"todo item",
			"task etag",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.getTodo(input as z.infer<typeof resourceSchema>);
		},
	},
	{
		name: "task_create",
		description:
			"Add a task or todo item to a calendar collection, optionally with recurrence and reminder alarms; recurring tasks require a start date or date-time, and calendar_calendars lists calendar UUIDs",
		inputSchema: createTaskSchema,
		keywords: [
			"create task",
			"add a task",
			"new todo",
			"recurring task",
			"daily todo",
			"remember to",
			"put task on list",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.createTodo(
				input as z.infer<typeof createTaskSchema>,
			);
		},
	},
	{
		name: "task_update",
		description:
			"Change a task's title, start, due date, recurrence, reminder alarms, description, priority, or status; mark it done by setting status to COMPLETED. Recurring tasks require a start; fields other than status can be null to clear them, and an ETag from task_read can make the update safe",
		inputSchema: updateTaskSchema,
		keywords: [
			"update task",
			"edit todo",
			"mark task done",
			"complete task",
			"change task due date",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.updateTodo(
				input as z.infer<typeof updateTaskSchema>,
			);
		},
	},
	{
		name: "task_delete",
		description: "Drop, delete, or remove a task or todo item",
		inputSchema: deleteTaskSchema,
		keywords: [
			"delete task",
			"drop that task",
			"remove todo",
			"discard todo item",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.removeTodo(
				input as z.infer<typeof deleteTaskSchema>,
			);
		},
	},
];
