import { describe, expect, it, vi } from "vitest";
import { memory } from "../src/capabilities/memory";
import type { Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";
import { MEMORY_INDEX_STATE_KEY } from "../src/memory";
import { InMemoryNotebookStore } from "../src/notebook/memory-store";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

function createDispatch(store = new InMemoryNotebookStore()) {
	const state = new Map<string, string>();
	const deleteByIds = vi.fn(async () => undefined);
	const env = {
		SEARCH_OFFLINE: "true",
		NOTEBOOK_STORE_FOR_TESTS: store,
		OAUTH_KV: {
			get: vi.fn(async (key: string) => state.get(key) ?? null),
			put: vi.fn(async (key: string, value: string) => {
				state.set(key, value);
			}),
		},
		VECTORIZE: { deleteByIds },
	} as unknown as Env;
	return {
		dispatch: buildDispatchTable(memory, env, props),
		store,
		state,
		deleteByIds,
	};
}

describe("memory capabilities", () => {
	it("remembers a new fact at an automatic path and returns its URL", async () => {
		const { dispatch, store } = createDispatch();

		const result = await dispatch.memory_remember!({
			content: "I prefer aisle seats.",
		});

		expect(result).toMatchObject({
			written: true,
			path: "memory/i-prefer-aisle-seats",
			metadata: { title: "i-prefer-aisle-seats" },
			url: "https://ayo.oflabs.dev/notebook/memory/i-prefer-aisle-seats",
		});
		await expect(store.read("memory/i-prefer-aisle-seats")).resolves.toMatchObject(
			{ content: "I prefer aisle seats." },
		);
	});

	it("refuses to write a related fact and returns the existing memory", async () => {
		const { dispatch } = createDispatch();
		await dispatch.memory_remember!({ content: "I prefer aisle seats." });

		const result = await dispatch.memory_remember!({
			content: "I prefer aisle seats when I fly.",
		});

		expect(result).toEqual({
			written: false,
			related: [
				{
					path: "memory/i-prefer-aisle-seats",
					title: "i-prefer-aisle-seats",
					content: "I prefer aisle seats.",
					url: "https://ayo.oflabs.dev/notebook/memory/i-prefer-aisle-seats",
				},
			],
			message:
				"A related memory already exists. Update one by passing its path, or pass force: true to save a separate memory.",
		});
	});

	it("writes a separate collision-safe path when force is true", async () => {
		const { dispatch } = createDispatch();
		await dispatch.memory_remember!({ content: "I prefer aisle seats." });

		const result = await dispatch.memory_remember!({
			content: "I prefer aisle seats.",
			force: true,
		});

		expect(result).toMatchObject({
			written: true,
			path: "memory/i-prefer-aisle-seats-2",
			url: "https://ayo.oflabs.dev/notebook/memory/i-prefer-aisle-seats-2",
		});
	});

	it("recalls a remembered fact with its canonical URL", async () => {
		const { dispatch } = createDispatch();
		await dispatch.memory_remember!({
			content: "I prefer aisle seats on flights.",
		});

		const result = await dispatch.memory_recall!({ query: "travel aisle seats" });

		expect(result).toEqual([
			expect.objectContaining({
				path: "memory/i-prefer-aisle-seats-on-flights",
				title: "i-prefer-aisle-seats-on-flights",
				content: "I prefer aisle seats on flights.",
				updatedAt: expect.any(String),
				url: "https://ayo.oflabs.dev/notebook/memory/i-prefer-aisle-seats-on-flights",
			}),
		]);
		expect(result).not.toEqual([expect.objectContaining({ score: expect.anything() })]);
	});

	it("forgets an existing fact, cleans its index state, and is honest when missing", async () => {
		const { dispatch, state, deleteByIds } = createDispatch();
		const remembered = (await dispatch.memory_remember!({
			content: "I prefer aisle seats.",
		})) as { path: string; version: string };
		state.set(
			MEMORY_INDEX_STATE_KEY,
			JSON.stringify({ [remembered.path]: remembered.version }),
		);

		await expect(
			dispatch.memory_forget!({ path: remembered.path }),
		).resolves.toEqual({ ok: true });
		expect(deleteByIds).toHaveBeenCalledWith([remembered.path]);
		expect(JSON.parse(state.get(MEMORY_INDEX_STATE_KEY)!)).toEqual({});

		await expect(
			dispatch.memory_forget!({ path: remembered.path }),
		).resolves.toEqual({
			ok: false,
			error: `No memory exists at ${remembered.path}`,
		});
		expect(deleteByIds).toHaveBeenCalledTimes(1);
	});

	it.each(["memory_remember", "memory_recall", "memory_forget"] as const)(
		"returns a structured error from %s without a backend",
		async (name) => {
			const dispatch = buildDispatchTable(memory, {} as Env, props);
			const input =
				name === "memory_remember"
					? { content: "Remember me" }
					: name === "memory_recall"
						? { query: "Remember me" }
						: { path: "memory/remember-me" };

			await expect(dispatch[name]!(input)).resolves.toEqual({
				error: "The notebook backend is not configured.",
			});
		},
	);
	it("updates a memory by its own path without refusing against itself", async () => {
		const { dispatch, store } = createDispatch();
		const first = (await dispatch.memory_remember!({
			content: "I prefer aisle seats on flights.",
		})) as { written: boolean; path: string };
		expect(first.written).toBe(true);
		const updated = (await dispatch.memory_remember!({
			content: "I prefer aisle seats on flights, ideally near the front.",
			path: first.path,
		})) as { written: boolean; path: string };
		expect(updated.written).toBe(true);
		expect(updated.path).toBe(first.path);
		const doc = await store.read(first.path);
		expect(doc?.content).toContain("near the front");
	});

	it("rejects forgetting paths outside memory/", async () => {
		const { dispatch } = createDispatch();
		await expect(
			dispatch.memory_forget!({ path: "briefs/2026-08-20" }),
		).rejects.toThrow();
	});

});
