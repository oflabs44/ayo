export type JobSchedule =
	| { type: "once"; runAt: string }
	| { type: "interval"; everyMs: number }
	| { type: "cron"; expression: string };

export const MIN_INTERVAL_MS = 60_000;

type CronFields = [
	Set<number>,
	Set<number>,
	Set<number>,
	Set<number>,
	Set<number>,
];

export function parseCron(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			`A cron expression has five fields: minute hour day-of-month month day-of-week. Got ${parts.length} in "${expression}".`,
		);
	}

	const bounds = [
		{ min: 0, max: 59, name: "minute" },
		{ min: 0, max: 23, name: "hour" },
		{ min: 1, max: 31, name: "day of month" },
		{ min: 1, max: 12, name: "month" },
		{ min: 0, max: 6, name: "day of week" },
	];

	return parts.map((part, index) =>
		parseCronField(part, bounds[index]!),
	) as CronFields;
}

function parseCronField(
	field: string,
	bound: { min: number; max: number; name: string },
): Set<number> {
	const values = new Set<number>();

	for (const term of field.split(",")) {
		const [range, stepText] = term.split("/");
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) {
			throw new Error(`Bad step "${stepText}" in the ${bound.name} field.`);
		}

		let from = bound.min;
		let to = bound.max;
		if (range !== "*" && range !== undefined) {
			const [fromText, toText] = range.split("-");
			from = Number(fromText);
			if (toText !== undefined) {
				to = Number(toText);
			} else if (stepText === undefined) {
				to = from;
			}
		}

		if (
			!Number.isInteger(from) ||
			!Number.isInteger(to) ||
			from < bound.min ||
			to > bound.max ||
			from > to
		) {
			throw new Error(
				`"${term}" is out of range for the ${bound.name} field (${bound.min}-${bound.max}).`,
			);
		}

		for (let value = from; value <= to; value += step) values.add(value);
	}

	return values;
}

function timezoneFormatter(timezone: string) {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hour12: false,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		weekday: "short",
	});
}

function partsIn(formatter: Intl.DateTimeFormat, at: Date) {
	const parts: Record<string, string> = {};
	for (const part of formatter.formatToParts(at)) parts[part.type] = part.value;
	const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

	return {
		minute: Number(parts.minute),
		hour: Number(parts.hour) % 24,
		day: Number(parts.day),
		month: Number(parts.month),
		weekday: weekdays.indexOf(parts.weekday ?? "Sun"),
	};
}

const MAX_CRON_SEARCH_MS = 4 * 366 * 24 * 60 * 60_000;

export function nextCronRun(input: {
	expression: string;
	timezone: string;
	after: number;
}): number {
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parseCron(
		input.expression,
	);
	const formatter = timezoneFormatter(input.timezone);
	const dayOfMonthRestricted = dayOfMonth.size < 31;
	const dayOfWeekRestricted = dayOfWeek.size < 7;
	let cursor =
		Math.floor(input.after / MIN_INTERVAL_MS) * MIN_INTERVAL_MS +
		MIN_INTERVAL_MS;
	const deadline = cursor + MAX_CRON_SEARCH_MS;

	while (cursor < deadline) {
		const at = partsIn(formatter, new Date(cursor));
		const dayMatches =
			dayOfMonthRestricted || dayOfWeekRestricted
				? (dayOfMonthRestricted && dayOfMonth.has(at.day)) ||
					(dayOfWeekRestricted && dayOfWeek.has(at.weekday))
				: true;

		if (!month.has(at.month) || !dayMatches) {
			// Stop an hour short because a local day can be 23 hours at DST.
			const minutesToMidnight = 24 * 60 - (at.hour * 60 + at.minute);
			cursor += Math.max(1, minutesToMidnight - 60) * MIN_INTERVAL_MS;
			continue;
		}
		if (!hour.has(at.hour)) {
			cursor += (60 - at.minute) * MIN_INTERVAL_MS;
			continue;
		}
		if (minute.has(at.minute)) return cursor;
		cursor += MIN_INTERVAL_MS;
	}

	throw new Error(
		`"${input.expression}" has no next run within four years. Check the day and month fields.`,
	);
}

export function nextRunAt(input: {
	schedule: JobSchedule;
	timezone?: string;
	after: number;
}): number | null {
	switch (input.schedule.type) {
		case "once": {
			const at = Date.parse(input.schedule.runAt);
			if (Number.isNaN(at)) {
				throw new Error(
					`"${input.schedule.runAt}" is not a timestamp. Use ISO 8601, e.g. 2026-08-13T09:00:00Z.`,
				);
			}
			return at > input.after ? at : null;
		}
		case "interval":
			if (input.schedule.everyMs < MIN_INTERVAL_MS) {
				throw new Error(
					`The shortest interval is ${MIN_INTERVAL_MS / 1_000}s. Anything faster is a process, not a schedule.`,
				);
			}
			return input.after + input.schedule.everyMs;
		case "cron":
			return nextCronRun({
				expression: input.schedule.expression,
				timezone: input.timezone ?? "UTC",
				after: input.after,
			});
	}
}

export function describeSchedule(
	schedule: JobSchedule,
	timezone = "UTC",
): string {
	switch (schedule.type) {
		case "once":
			return `once at ${schedule.runAt}`;
		case "interval":
			return `every ${formatDuration(schedule.everyMs)}`;
		case "cron":
			return `cron "${schedule.expression}" (${timezone})`;
	}
}

function formatDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
