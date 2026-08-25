import { describe, expect, it, vi } from "vitest";
import { calendar } from "../src/capabilities/calendar";
import type { BureauBinding, Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const address = "oladayo@example.com";
const calendarId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const props: OwnerProps = {
	email: address,
	name: "Oladayo",
	sub: "ayo-owner",
};

function createHarness() {
	const bureau = {
		listCalendars: vi.fn(async () => []),
		listEvents: vi.fn(async () => []),
		getEvent: vi.fn(),
		createEvent: vi.fn(),
		updateEvent: vi.fn(),
		removeEvent: vi.fn(),
	} as unknown as BureauBinding;
	const env = { BUREAU: bureau } as unknown as Env;

	return {
		bureau,
		dispatch: buildDispatchTable(calendar, env, props),
	};
}

const eventWrite = {
	address,
	calendar: calendarId,
	summary: "Planning",
	start: "2026-08-24T10:00:00+02:00",
	end: "2026-08-24T11:00:00+02:00",
	location: "Room 4",
	description: "Quarterly planning",
	rrule: "FREQ=WEEKLY;COUNT=2",
	alarms: [
		{
			trigger: "-PT15M",
			action: "DISPLAY" as const,
			description: "Planning soon",
		},
	],
};

describe("calendar capabilities", () => {
	it("lists calendars with the exact Bureau RPC shape", async () => {
		const { bureau, dispatch } = createHarness();

		await dispatch.calendar_calendars!({ address });

		expect(bureau.listCalendars).toHaveBeenCalledWith({ address });
	});

	it("forwards event windows and calendar filters without owning Bureau's bounds", async () => {
		const { bureau, dispatch } = createHarness();
		const input = {
			address,
			from: "2026-01-01T00:00:00Z",
			to: "2026-04-04T00:00:00Z",
			calendar: calendarId,
		};

		await dispatch.calendar_events!(input);

		expect(bureau.listEvents).toHaveBeenCalledWith(input);
	});

	it("surfaces Bureau's own window validation unchanged", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.listEvents).mockRejectedValueOnce(
			new Error("invalid_input: to must be later than from"),
		);

		await expect(
			dispatch.calendar_events!({
				address,
				from: "2026-02-01T00:00:00Z",
				to: "2026-01-01T00:00:00Z",
			}),
		).rejects.toThrow("to must be later than from");
	});

	it("reads one event with the exact Bureau RPC shape", async () => {
		const { bureau, dispatch } = createHarness();

		await dispatch.calendar_event_read!({ address, id: eventId });

		expect(bureau.getEvent).toHaveBeenCalledWith({ address, id: eventId });
	});

	it("creates an event without forwarding Bureau's attendee field", async () => {
		const { bureau, dispatch } = createHarness();

		await dispatch.calendar_event_create!({
			...eventWrite,
			attendees: [{ email: "reader@example.com" }],
		});

		expect(bureau.createEvent).toHaveBeenCalledWith(eventWrite);
	});

	it("updates an event with its required ETag and exact Bureau RPC shape", async () => {
		const { bureau, dispatch } = createHarness();
		const input = { ...eventWrite, id: eventId, etag: '"event-v2"' };

		await dispatch.calendar_event_update!(input);

		expect(bureau.updateEvent).toHaveBeenCalledWith(input);
	});

	it("refuses an event update without an ETag", async () => {
		const { bureau, dispatch } = createHarness();

		await expect(
			dispatch.calendar_event_update!({ ...eventWrite, id: eventId }),
		).rejects.toThrow();
		expect(bureau.updateEvent).not.toHaveBeenCalled();
	});

	it("deletes an event with Bureau's optional ETag shape", async () => {
		const { bureau, dispatch } = createHarness();
		const input = { address, id: eventId, etag: '"event-v2"' };

		await dispatch.calendar_event_delete!(input);

		expect(bureau.removeEvent).toHaveBeenCalledWith(input);
	});
});
