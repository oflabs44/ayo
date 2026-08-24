import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { surfaceMemories } from "../src/memory/surface";
import { InMemoryNotebookStore } from "../src/notebook/memory-store";

function createEnv(): Env {
	const values = new Map<string, string>();
	return {
		SEARCH_OFFLINE: "true",
		OAUTH_KV: {
			get: vi.fn(async (key: string) => values.get(key) ?? null),
			put: vi.fn(async (key: string, value: string) => {
				values.set(key, value);
			}),
		},
	} as unknown as Env;
}

describe("surfaceMemories", () => {
	it("caps ambient memories at two compact one-liners", async () => {
		const env = createEnv();
		const store = new InMemoryNotebookStore();
		for (const slug of ["a", "b", "c"]) {
			await store.write(`memory/aisle-${slug}`, {
				content: "prefers aisle seats when booking flights",
			});
		}
		const surfaced = await surfaceMemories(
			env,
			store,
			"booking flights with aisle seats",
		);
		expect(surfaced).toEqual([
			{
				path: expect.stringMatching(/^memory\/aisle-/),
				line: expect.stringContaining(
					"— prefers aisle seats when booking flights",
				),
			},
			{
				path: expect.stringMatching(/^memory\/aisle-/),
				line: expect.stringContaining(
					"— prefers aisle seats when booking flights",
				),
			},
		]);
	});

	it("collapses whitespace and truncates long content to one line", async () => {
		const env = createEnv();
		const store = new InMemoryNotebookStore();
		await store.write("memory/aisle-long", {
			title: "Aisle\nseats",
			content: `prefers aisle seats\nwhen booking flights ${"x".repeat(120)}`,
		});
		const [surfaced] = await surfaceMemories(
			env,
			store,
			"booking flights with aisle seats",
		);
		expect(surfaced.line).not.toContain("\n");
		expect(surfaced.line.endsWith("…")).toBe(true);
	});

	it("surfaces the same memory again on a later call", async () => {
		const env = createEnv();
		const store = new InMemoryNotebookStore();
		await store.write("memory/aisle-one", {
			content: "prefers aisle seats when booking flights",
		});

		const first = await surfaceMemories(
			env,
			store,
			"booking flights with aisle seats",
		);
		const again = await surfaceMemories(
			env,
			store,
			"booking flights with aisle seats",
		);
		expect(first.map((m) => m.path)).toEqual(["memory/aisle-one"]);
		expect(again).toEqual(first);
	});
});
