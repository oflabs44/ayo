import { z } from "zod";
import type { Capability } from "./index";

const BACKEND_NOT_CONFIGURED = "The tasks backend is not configured.";

const accountSchema = z.object({ address: z.email() });
const resourceSchema = accountSchema.extend({ id: z.uuid() });
const calendarDateTimeSchema = z.iso.datetime({ offset: true });
const calendarTimeSchema = z.union([z.iso.date(), calendarDateTimeSchema]);
const listTasksSchema = accountSchema.extend({
	calendar: z.uuid().optional(),
	status: z.string().min(1).optional(),
	dueBefore: calendarTimeSchema.optional(),
});
const taskCreateBodySchema = z.object({
	calendar: z.uuid(),
	summary: z.string().min(1),
	due: calendarTimeSchema.optional(),
	description: z.string().optional(),
	priority: z.int().min(0).max(9).optional(),
	status: z.string().min(1).optional(),
});
const createTaskSchema = taskCreateBodySchema.safeExtend(accountSchema.shape);
const taskUpdateBodySchema = z
	.object({
		status: z.string().min(1).optional(),
		due: calendarTimeSchema.nullable().optional(),
		summary: z.string().min(1).nullable().optional(),
		description: z.string().nullable().optional(),
		priority: z.int().min(0).max(9).nullable().optional(),
	})
	.refine(
		(input) =>
			input.status !== undefined ||
			input.due !== undefined ||
			input.summary !== undefined ||
			input.description !== undefined ||
			input.priority !== undefined,
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
			"Find overdue tasks or tasks due before a date, optionally filtered by calendar or status",
		inputSchema: listTasksSchema,
		keywords: [
			"list tasks",
			"tasks due this week",
			"overdue tasks",
			"what is on my plate",
			"open todos",
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
			"Add a task or todo item to a calendar collection; use calendar_calendars first to find the calendar UUID",
		inputSchema: createTaskSchema,
		keywords: [
			"create task",
			"add a task",
			"new todo",
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
			"Change a task's title, due date, description, priority, or status; mark it done by setting status to COMPLETED. Fields other than status can be null to clear them, and an ETag from task_read can make the update safe",
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
