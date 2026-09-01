import { z } from "zod";
import type { Capability } from "./index";

const BACKEND_NOT_CONFIGURED = "The calendar backend is not configured.";

const accountSchema = z.object({ address: z.email() });
const resourceSchema = accountSchema.extend({ id: z.uuid() });
const calendarDateTimeSchema = z.iso.datetime({ offset: true });
const calendarTimeSchema = z.union([z.iso.date(), calendarDateTimeSchema]);
const alarmSchema = z.object({
	trigger: z.string().min(1),
	action: z.enum(["DISPLAY", "EMAIL", "AUDIO"]).optional(),
	description: z.string().optional(),
});

// Bureau accepts attendees, but Ayo excludes them so event creation cannot imply sending invitations.
const eventWriteSchema = z
	.object({
		calendar: z.uuid(),
		summary: z.string().min(1),
		start: calendarTimeSchema,
		end: calendarTimeSchema.optional(),
		duration: z.string().min(1).optional(),
		allDay: z.boolean().optional(),
		location: z.string().optional(),
		description: z.string().optional(),
		rrule: z.string().min(1).optional(),
		alarms: z.array(alarmSchema).optional(),
	})
	.superRefine((input, context) => {
		if ((input.end === undefined) === (input.duration === undefined)) {
			context.addIssue({
				code: "custom",
				message: "Exactly one of end or duration is required",
			});
		}

		const startIsDate = input.start.length === 10;
		const allDay = input.allDay ?? startIsDate;
		const endHasWrongFormat = input.end
			? allDay !== (input.end.length === 10)
			: false;
		if (allDay !== startIsDate || endHasWrongFormat) {
			context.addIssue({
				code: "custom",
				message: "allDay events use dates; timed events use date-times",
			});
		}
		if (input.end && compareCalendarTimes(input.end, input.start) <= 0) {
			context.addIssue({
				code: "custom",
				message: "end must be later than start",
			});
		}
	});
// Create only: renaming or deleting a calendar collection takes its events
// with it, so those stay in Bureau's own UI.
const calendarWriteSchema = accountSchema.extend({
	name: z.string().min(1),
	color: z.string().min(1).optional(),
});
const createCalendarSchema = calendarWriteSchema;
const listEventsSchema = accountSchema.extend({
	from: calendarDateTimeSchema,
	to: calendarDateTimeSchema,
	calendar: z.uuid().optional(),
});
const createEventSchema = eventWriteSchema.safeExtend(accountSchema.shape);
const updateEventSchema = eventWriteSchema.safeExtend({
	...resourceSchema.shape,
	etag: z.string().min(1),
});
const deleteEventSchema = resourceSchema.extend({
	etag: z.string().min(1).optional(),
});

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function compareCalendarTimes(left: string, right: string): number {
	if (left.length === 10 && right.length === 10) return left.localeCompare(right);
	return new Date(left).getTime() - new Date(right).getTime();
}

export const calendar: Capability[] = [
	{
		name: "calendar_calendars",
		description: "Find which calendars are available in an email account",
		inputSchema: accountSchema,
		// No "calendar folders" here. Once email_mailboxes existed, that keyword
		// took "what are my mail folders" and "show me my email folders" to the
		// calendar - restoring it fails those golden queries. The cost is real and
		// unguarded: folder-language calendar queries now tie among the calendar
		// capabilities, and no golden query can pin them because none wins on
		// score. Ayo's calendars are not folders, so the word belongs to mail.
		keywords: [
			"list calendars",
			"list my calendars",
			"available calendars",
			"choose a calendar",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.listCalendars(input as z.infer<typeof accountSchema>);
		},
	},
	{
		name: "calendar_create",
		description: "Make a new empty calendar in an account",
		inputSchema: createCalendarSchema,
		keywords: [
			"create a calendar",
			"new calendar",
			"add a separate calendar",
			"calendar for a project",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			const created = await env.BUREAU.createCalendar(
				input as z.infer<typeof createCalendarSchema>,
			);
			return { created: true, calendar: created };
		},
	},
	{
		name: "calendar_events",
		description:
			"Find appointments, meetings, and other events scheduled between two dates",
		inputSchema: listEventsSchema,
		keywords: [
			"calendar schedule",
			"events this week",
			"upcoming appointments",
			"agenda between dates",
			"what is scheduled",
			"what is on my calendar this week",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.listEvents(input as z.infer<typeof listEventsSchema>);
		},
	},
	{
		name: "calendar_event_read",
		description: "Open one calendar event and show all of its details",
		inputSchema: resourceSchema,
		keywords: [
			"read calendar event",
			"appointment details",
			"open meeting",
			"show event",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.getEvent(input as z.infer<typeof resourceSchema>);
		},
	},
	{
		name: "calendar_event_create",
		description:
			"Add a new appointment, meeting, or other event to a calendar without inviting attendees",
		inputSchema: createEventSchema,
		keywords: [
			"create calendar event",
			"add meeting",
			"schedule appointment",
			"book time",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.createEvent(
				input as z.infer<typeof createEventSchema>,
			);
		},
	},
	{
		name: "calendar_event_update",
		description:
			"Change the time, title, location, recurrence, or other details of a calendar event",
		inputSchema: updateEventSchema,
		keywords: [
			"update calendar event",
			"edit appointment",
			"reschedule meeting",
			"move meeting to another time",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.updateEvent(
				input as z.infer<typeof updateEventSchema>,
			);
		},
	},
	{
		name: "calendar_event_delete",
		description: "Cancel or remove an appointment, meeting, or calendar event",
		inputSchema: deleteEventSchema,
		keywords: [
			"delete calendar event",
			"cancel appointment",
			"remove meeting",
			"clear event",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.removeEvent(
				input as z.infer<typeof deleteEventSchema>,
			);
		},
	},
];
