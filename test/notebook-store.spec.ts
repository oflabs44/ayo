import { describe, expect, it } from "vitest";
import { InMemoryNotebookStore } from "../src/notebook/memory-store";
import type { NotebookStore } from "../src/notebook/store";

const implementations: Array<[string, () => NotebookStore]> = [
	["in-memory", () => new InMemoryNotebookStore()],
];

describe.each(implementations)("NotebookStore: %s", (_name, createStore) => {
	it("creates and updates a document", async () => {
		const store = createStore();
		const created = await store.write("briefs/2026-08-20", {
			content: "First draft",
		});
		const updated = await store.write("briefs/2026-08-20", {
			content: "Final draft",
			title: "August brief",
		});

		expect(created.metadata.title).toBe("2026-08-20");
		expect(updated).toMatchObject({
			path: "briefs/2026-08-20",
			content: "Final draft",
			metadata: {
				title: "August brief",
				createdAt: created.metadata.createdAt,
			},
		});
		expect(updated.metadata.updatedAt).not.toBe(created.metadata.updatedAt);
		expect(updated.version).not.toBe(created.version);
	});

	it("returns null for a missing document", async () => {
		const store = createStore();

		await expect(store.read("notes/missing")).resolves.toBeNull();
	});

	it("lists metadata by path prefix in path order", async () => {
		const store = createStore();
		await store.write("notes/z-last", { content: "Z" });
		await store.write("briefs/ignored", { content: "Brief" });
		await store.write("notes/a-first", { content: "A" });

		const listed = await store.list("notes");

		expect(listed.map(({ path }) => path)).toEqual([
			"notes/a-first",
			"notes/z-last",
		]);
		expect(listed.every((doc) => !("content" in doc))).toBe(true);
	});

	it("deletes a document", async () => {
		const store = createStore();
		await store.write("memory/aisle-seats", { content: "Likes aisle seats" });

		await store.delete("memory/aisle-seats");

		await expect(store.read("memory/aisle-seats")).resolves.toBeNull();
	});

	it.each([
		"",
		"/notes/example",
		"notes/example/",
		"notes//example",
		"notes/../example",
		"Notes/example",
		"notes/has space",
		"notes/example@home",
	])("rejects invalid path %j", async (path) => {
		const store = createStore();

		await expect(store.write(path, { content: "invalid" })).rejects.toThrow(
			"Invalid notebook path",
		);
	});

	it("validates paths used by read, list, and delete", async () => {
		const store = createStore();

		await expect(store.read("../notes")).rejects.toThrow(
			"Invalid notebook path",
		);
		await expect(store.list("notes/")).rejects.toThrow(
			"Invalid notebook path",
		);
		await expect(store.delete("notes//example")).rejects.toThrow(
			"Invalid notebook path",
		);
	});

	it("changes the version when the same document is rewritten", async () => {
		const store = createStore();
		const first = await store.write("notes/rewrite", { content: "Same" });
		const second = await store.write("notes/rewrite", { content: "Same" });

		expect(second.version).not.toBe(first.version);
	});
});
