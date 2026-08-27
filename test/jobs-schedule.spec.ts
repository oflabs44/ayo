import { describe, expect, it } from "vitest";
import {
	nextCronRun,
	nextRunAt,
	parseCron,
} from "../src/jobs/schedule";

const at = Date.parse;
const iso = (value: number) => new Date(value).toISOString();

describe("job schedule arithmetic", () => {
	it("validates five cron fields and their bounds", () => {
		expect(() => parseCron("* * * *")).toThrow(/five fields/);
		expect(() => parseCron("0 24 * * *")).toThrow(/hour/);
		expect(() => parseCron("0 9 * * * *")).toThrow(/five fields/);
	});

	it("crosses month and weekday boundaries with crontab OR semantics", () => {
		expect(
			iso(
				nextCronRun({
					expression: "0 9 1 * 1",
					timezone: "UTC",
					after: at("2026-08-28T00:00:00Z"),
				}),
			),
		).toBe("2026-08-31T09:00:00.000Z");
	});

	it("finds the next leap-day month boundary", () => {
		expect(
			iso(
				nextCronRun({
					expression: "0 0 29 2 *",
					timezone: "UTC",
					after: at("2026-03-01T00:00:00Z"),
				}),
			),
		).toBe("2028-02-29T00:00:00.000Z");
	});

	it("keeps a local cron hour across daylight-saving time", () => {
		const summer = nextCronRun({
			expression: "0 9 * * *",
			timezone: "Europe/Berlin",
			after: at("2026-08-12T00:00:00Z"),
		});
		const winter = nextCronRun({
			expression: "0 9 * * *",
			timezone: "Europe/Berlin",
			after: at("2026-12-12T00:00:00Z"),
		});
		expect(iso(summer)).toBe("2026-08-12T07:00:00.000Z");
		expect(iso(winter)).toBe("2026-12-12T08:00:00.000Z");
	});

	it("calculates interval and one-off schedules", () => {
		expect(
			nextRunAt({
				schedule: { type: "interval", everyMs: 900_000 },
				after: at("2026-08-12T09:00:00Z"),
			}),
		).toBe(at("2026-08-12T09:15:00Z"));
		expect(
			nextRunAt({
				schedule: { type: "once", runAt: "2026-08-12T08:00:00Z" },
				after: at("2026-08-12T09:00:00Z"),
			}),
		).toBeNull();
	});

	it("enforces the one-minute interval floor", () => {
		expect(() =>
			nextRunAt({
				schedule: { type: "interval", everyMs: 59_999 },
				after: 0,
			}),
		).toThrow(/shortest interval/);
	});
});
