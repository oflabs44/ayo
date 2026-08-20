import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
	buildMemoryEmbedText,
	MEMORY_INDEX_STATE_KEY,
	recallMemories,
	syncMemoryIndex,
} from "../src/memory/index";
import { InMemoryNotebookStore } from "../src/notebook/memory-store";
import { EMBEDDING_MAX_INPUT_CHARS } from "../src/search";

function createOnlineEnv() {
	const state = new Map<string, string>();
	const get = vi.fn(async (key: string) => state.get(key) ?? null);
	const put = vi.fn(async (key: string, value: string) => {
		state.set(key, value);
	});
	const aiRun = vi.fn(async (_model: string, input: { text: string[] }) => ({
		data: input.text.map((_, index) => Array<number>(384).fill(index + 1)),
	}));
	const upsert = vi.fn(async () => undefined);
	const deleteByIds = vi.fn(async () => undefined);
	const query = vi.fn(async () => ({ matches: [] as Array<{ id: string; score: number }> }));
	const env = {
		AI: { run: aiRun },
		VECTORIZE: { upsert, deleteByIds, query },
		OAUTH_KV: { get, put },
	} as unknown as Env;
	return { env, aiRun, upsert, deleteByIds, query, get, put, state };
}

describe("memory index", () => {
	it("builds bounded embedding text from title and content", async () => {
		const store = new InMemoryNotebookStore();
		const doc = await store.write("memory/bounded", {
			title: "Bounded memory",
			content: "x".repeat(EMBEDDING_MAX_INPUT_CHARS),
		});

		const text = buildMemoryEmbedText(doc);

		expect(text).toHaveLength(EMBEDDING_MAX_INPUT_CHARS);
		expect(text).toMatch(/^Bounded memory\n/);
	});

	it("syncs changed memories in one batch and writes the version map", async () => {
		const store = new InMemoryNotebookStore();
		const first = await store.write("memory/aisle-seats", {
			title: "Seat preference",
			content: "I prefer aisle seats.",
		});
		const second = await store.write("memory/tea", {
			title: "Tea",
			content: "I drink green tea.",
		});
		await store.write("notes/not-a-memory", { content: "Ignore me" });
		const { env, aiRun, upsert, put } = createOnlineEnv();

		await syncMemoryIndex(env, store);

		expect(aiRun).toHaveBeenCalledWith("@cf/baai/bge-small-en-v1.5", {
			text: ["Seat preference\nI prefer aisle seats.", "Tea\nI drink green tea."],
		});
		expect(upsert).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "memory/aisle-seats",
				namespace: "memories",
			}),
			expect.objectContaining({
				id: "memory/tea",
				namespace: "memories",
			}),
		]);
		const state = JSON.parse(
			put.mock.calls.find(([key]) => key === MEMORY_INDEX_STATE_KEY)![1],
		) as Record<string, string>;
		expect(state).toEqual({
			"memory/aisle-seats": first.version,
			"memory/tea": second.version,
		});
	});

	it("re-embeds a memory when its version changes", async () => {
		const store = new InMemoryNotebookStore();
		await store.write("memory/seat", { content: "Window seat" });
		const { env, aiRun, upsert } = createOnlineEnv();
		await syncMemoryIndex(env, store);
		vi.clearAllMocks();

		await store.write("memory/seat", { content: "Aisle seat" });
		await syncMemoryIndex(env, store);

		expect(aiRun).toHaveBeenCalledTimes(1);
		expect(aiRun).toHaveBeenCalledWith("@cf/baai/bge-small-en-v1.5", {
			text: ["seat\nAisle seat"],
		});
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it("deletes vectors for memories removed from the notebook", async () => {
		const store = new InMemoryNotebookStore();
		await store.write("memory/remove-me", { content: "Temporary" });
		const { env, deleteByIds } = createOnlineEnv();
		await syncMemoryIndex(env, store);
		vi.clearAllMocks();

		await store.delete("memory/remove-me");
		await syncMemoryIndex(env, store);

		expect(deleteByIds).toHaveBeenCalledWith(["memory/remove-me"]);
	});

	it("recalls a seeded memory lexically while offline", async () => {
		const store = new InMemoryNotebookStore();
		await store.write("memory/aisle-seats", {
			title: "Seat preference",
			content: "I prefer aisle seats on flights.",
		});
		await store.write("memory/tea", { content: "I drink tea." });
		const aiRun = vi.fn();
		const vectorQuery = vi.fn();
		const kvGet = vi.fn();
		const env = {
			SEARCH_OFFLINE: "true",
			AI: { run: aiRun },
			VECTORIZE: { query: vectorQuery },
			OAUTH_KV: { get: kvGet },
		} as unknown as Env;

		const recalled = await recallMemories(env, store, "aisle seat");

		expect(recalled[0]).toMatchObject({
			path: "memory/aisle-seats",
			title: "Seat preference",
			content: "I prefer aisle seats on flights.",
			updatedAt: expect.any(String),
			score: expect.any(Number),
		});
		expect(aiRun).not.toHaveBeenCalled();
		expect(vectorQuery).not.toHaveBeenCalled();
		expect(kvGet).not.toHaveBeenCalled();
	});

	it("includes vector neighbors in online recall", async () => {
		const store = new InMemoryNotebookStore();
		await store.write("memory/semantic", {
			title: "Travel",
			content: "Prefers quiet train carriages.",
		});
		const { env, query } = createOnlineEnv();
		query.mockResolvedValue({
			matches: [{ id: "memory/semantic", score: 0.9 }],
		});

		const recalled = await recallMemories(env, store, "unrelated terms");

		expect(recalled).toEqual([
			expect.objectContaining({ path: "memory/semantic" }),
		]);
		expect(query).toHaveBeenCalledWith(expect.any(Array), {
			topK: 5,
			namespace: "memories",
		});
	});
});
