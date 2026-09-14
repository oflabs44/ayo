import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilities, type Capability } from "../src/capabilities";
import type { Env, OwnerProps } from "../src/env";
import {
	buildDispatchTable,
	describeError,
	executeCode,
	inlineDefaultExport,
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

describe("default export inlining", () => {
	it("leaves a lone default export for codemode to normalize", () => {
		const code = "// note\nexport default async function () { return 7; }";

		expect(inlineDefaultExport(code)).toBe(code);
	});

	it("calls an anonymous default export after top-level helpers", () => {
		expect(
			inlineDefaultExport(
				"const X = 1;\nexport default async function () { return X; }",
			),
		).toBe(
			"async () => {\nconst X = 1;\n\nreturn (async function () { return X; })();\n}",
		);
	});

	it("inlines a module wrapped in a Markdown code fence", () => {
		expect(
			inlineDefaultExport(
				"```js\nconst X = 1;\nexport default async () => X;\n```",
			),
		).toBe("async () => {\nconst X = 1;\n\n\nreturn (async () => X)();\n}");
	});

	it("keeps a named default export hoisted and calls it by name", () => {
		expect(
			inlineDefaultExport(
				"export default async function main() { return f(); }\nfunction f() { return 6; }",
			),
		).toBe(
			"async () => {\nasync function main() { return f(); }\nfunction f() { return 6; }\nreturn main();\n}",
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
