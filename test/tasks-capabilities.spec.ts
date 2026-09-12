import { describe, expect, it, vi } from "vitest";
import { tasks } from "../src/capabilities/tasks";
import type { BureauBinding, Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const address = "oladayo@example.com";
const calendarId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const props: OwnerProps = {
	email: address,
	name: "Oladayo",
	sub: "ayo-owner",
};

function createHarness() {
	const bureau = {
		listTodos: vi.fn(async () => []),
		getTodo: vi.fn(),
		createTodo: vi.fn(),
		updateTodo: vi.fn(),
		removeTodo: vi.fn(),
	} as unknown as BureauBinding;
	const env = { BUREAU: bureau } as Env;

	return {
		bureau,
		dispatch: buildDispatchTable(tasks, env, props),
	};
}

describe("tasks capabilities", () => {
	it("lists tasks with the exact Bureau RPC shape", async () => {
		const { bureau, dispatch } = createHarness();
		const input = {
			address,
			calendar: calendarId,
			status: "NEEDS-ACTION",
			dueBefore: "2026-08-31T23:59:59+02:00",
		};

		await dispatch.task_list!(input);

		expect(bureau.listTodos).toHaveBeenCalledWith(input);
	});

	it("keeps status and completion time in unfiltered task rows", async () => {
		const { bureau, dispatch } = createHarness();
		const completedTask = {
			id: taskId,
			calendar: calendarId,
			uid: "completed-task",
			summary: "Submit report",
			status: "COMPLETED",
			start: "2026-09-08",
			due: "2026-09-08",
			completed: "2026-09-08T18:00:00.000Z",
			priority: 0,
			alarms: [],
			etag: '"task-v2"',
		};
		vi.mocked(bureau.listTodos).mockResolvedValueOnce([completedTask]);

		const result = await dispatch.task_list!({ address });

		expect(bureau.listTodos).toHaveBeenCalledWith({ address });
		expect(result).toEqual([completedTask]);
	});

	it("reads one task with the exact Bureau RPC shape", async () => {
		const { bureau, dispatch } = createHarness();

		await dispatch.task_read!({ address, id: taskId });

		expect(bureau.getTodo).toHaveBeenCalledWith({ address, id: taskId });
	});

	it("creates a task with the exact Bureau RPC shape", async () => {
		const { bureau, dispatch } = createHarness();
		const input = {
			address,
			calendar: calendarId,
			summary: "Buy groceries",
			due: "2026-08-24",
			description: "Milk and bread",
			priority: 3,
			status: "NEEDS-ACTION",
		};

		await dispatch.task_create!(input);

		expect(bureau.createTodo).toHaveBeenCalledWith(input);
	});

	it("allows equal start and due dates for same-day tasks", async () => {
		const { bureau, dispatch } = createHarness();
		const input = {
			address,
			calendar: calendarId,
			summary: "One-day task",
			start: "2026-09-08",
			due: "2026-09-08",
			rrule: "FREQ=DAILY",
		};

		await dispatch.task_create!(input);

		expect(bureau.createTodo).toHaveBeenCalledWith(input);
	});

	it("creates, updates, and clears recurrence rules", async () => {
		const { bureau, dispatch } = createHarness();
		const rrule = "FREQ=DAILY";
		const start = "2026-08-26T18:00:00+02:00";

		await dispatch.task_create!({
			address,
			calendar: calendarId,
			summary: "Drink water",
			start,
			rrule,
		});
		expect(bureau.createTodo).toHaveBeenCalledWith(
			expect.objectContaining({ start, rrule }),
		);

		await dispatch.task_update!({ address, id: taskId, rrule });
		expect(bureau.updateTodo).toHaveBeenCalledWith({
			address,
			id: taskId,
			rrule,
		});

		await dispatch.task_update!({ address, id: taskId, rrule: null });
		expect(bureau.updateTodo).toHaveBeenCalledWith({
			address,
			id: taskId,
			rrule: null,
		});

		await expect(
			dispatch.task_create!({
				address,
				calendar: calendarId,
				summary: "No recurrence anchor",
				rrule,
			}),
		).rejects.toThrow("Recurring tasks require a start");
	});

	it("carries reminder alarms on create and alarm-only updates and clearing", async () => {
		const { bureau, dispatch } = createHarness();
		const alarms = [
			{
				trigger: "-PT15M",
				action: "DISPLAY" as const,
				related: "END" as const,
				description: "Soon",
			},
		];

		await dispatch.task_create!({
			address,
			calendar: calendarId,
			summary: "Drink water",
			due: "2026-08-26T18:00:00+02:00",
			alarms,
		});
		expect(bureau.createTodo).toHaveBeenCalledWith(
			expect.objectContaining({ alarms }),
		);

		await dispatch.task_update!({ address, id: taskId, alarms });
		expect(bureau.updateTodo).toHaveBeenCalledWith({
			address,
			id: taskId,
			alarms,
		});

		await dispatch.task_update!({ address, id: taskId, alarms: null });
		expect(bureau.updateTodo).toHaveBeenCalledWith({
			address,
			id: taskId,
			alarms: null,
		});
	});

	it("updates a task with only status COMPLETED", async () => {
		const { bureau, dispatch } = createHarness();
		const input = { address, id: taskId, status: "COMPLETED" };

		await dispatch.task_update!(input);

		expect(bureau.updateTodo).toHaveBeenCalledWith(input);
	});

	it("forwards nullable fields for clearing", async () => {
		const { bureau, dispatch } = createHarness();
		const input = {
			address,
			id: taskId,
			etag: '"task-v2"',
			due: null,
			summary: null,
			description: null,
			priority: null,
		};

		await dispatch.task_update!(input);

		expect(bureau.updateTodo).toHaveBeenCalledWith(input);
	});

	it("refuses an update when no task field is given", async () => {
		const { bureau, dispatch } = createHarness();

		await expect(
			dispatch.task_update!({ address, id: taskId, etag: '"task-v2"' }),
		).rejects.toThrow("At least one todo field is required");
		expect(bureau.updateTodo).not.toHaveBeenCalled();
	});

	it("deletes a task with Bureau's optional ETag shape", async () => {
		const { bureau, dispatch } = createHarness();
		const input = { address, id: taskId, etag: '"task-v2"' };

		await dispatch.task_delete!(input);

		expect(bureau.removeTodo).toHaveBeenCalledWith(input);
	});

	it("propagates a Bureau error unchanged", async () => {
		const { bureau, dispatch } = createHarness();
		const error = new Error("upstream: CalDAV request failed");
		vi.mocked(bureau.listTodos).mockRejectedValueOnce(error);

		await expect(dispatch.task_list!({ address })).rejects.toBe(error);
	});
});
