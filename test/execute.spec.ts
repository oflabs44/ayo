import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilities, type Capability } from "../src/capabilities";
import type { Env, OwnerProps } from "../src/env";
import {
	buildDispatchTable,
	describeError,
	executeCode,
} from "../src/execute";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};
const testEnv = {} as Env;

afterEach(() => vi.restoreAllMocks());

describe("execute sandbox", () => {
	it("reports when the LOADER binding is unavailable", async () => {
		await expect(
			executeCode({
				code: "export default async function main() {}",
				env: testEnv,
				props,
			}),
		).resolves.toEqual({
			logs: [],
			error:
				"The sandbox is unavailable: no LOADER binding. Capabilities cannot run.",
		});
	});

	it("adds a useful hint when the timeout budget is exhausted", () => {
		expect(describeError("Execution timed out", 30_000)).toBe(
			"Execution timed out — the script exceeded the 30s budget. Split the work.",
		);
	});
});

describe("execute dispatch table", () => {
	it("passes caller OAuth properties to whoami", async () => {
		const dispatch = buildDispatchTable(capabilities, testEnv, props);

		await expect(dispatch.whoami!({})).resolves.toEqual(props);
	});

	it("rejects invalid capability input with zod", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const handler = vi.fn();
		const capability: Capability = {
			name: "requires_count",
			description: "Test input validation",
			inputSchema: z.object({ count: z.number() }),
			handler,
		};
		const dispatch = buildDispatchTable([capability], testEnv, props);

		await expect(
			dispatch.requires_count!({ count: "not a number" }),
		).rejects.toBeInstanceOf(z.ZodError);
		expect(handler).not.toHaveBeenCalled();
	});

	it("logs a throwing capability name before propagating", async () => {
		const error = new Error("handler failed");
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const capability: Capability = {
			name: "throws",
			description: "Test handler failures",
			inputSchema: z.object({}),
			handler: () => {
				throw error;
			},
		};
		const dispatch = buildDispatchTable([capability], testEnv, props);

		await expect(dispatch.throws!({})).rejects.toBe(error);
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining("throws"),
			error,
		);
	});
});
