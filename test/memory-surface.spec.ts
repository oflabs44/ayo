import { describe, expect, it, vi } from "vitest";
import { markSurfaced } from "../src/conversation";
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
	it("caps ambient memories at three", async () => {
		const env = createEnv();
		const store = new InMemoryNotebookStore();
		for (const slug of ["a", "b", "c", "d"]) {
			await store.write(`memory/aisle-${slug}`, {
				content: "prefers aisle seats when booking flights",
			});
		}
		const surfaced = await surfaceMemories(env, store, {
			memoryContext: "booking flights with aisle seats",
			conversationId: "conv-1",
		});
		expect(surfaced.length).toBe(3);
	});

	it("skips already-surfaced memories and marks only the fresh ones", async () => {
		const env = createEnv();
		const store = new InMemoryNotebookStore();
		await store.write("memory/aisle-one", {
			content: "prefers aisle seats when booking flights",
		});
		await store.write("memory/aisle-two", {
			content: "books flights with aisle seats early",
		});
		await markSurfaced(env, "conv-2", ["memory/aisle-one"]);

		const surfaced = await surfaceMemories(env, store, {
			memoryContext: "booking flights with aisle seats",
			conversationId: "conv-2",
		});
		expect(surfaced.map((m) => m.path)).toEqual(["memory/aisle-two"]);

		const again = await surfaceMemories(env, store, {
			memoryContext: "booking flights with aisle seats",
			conversationId: "conv-2",
		});
		expect(again).toEqual([]);
	});
});
