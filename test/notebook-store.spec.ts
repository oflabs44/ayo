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

		const listed = await store.list({ prefix: "notes" });

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
		await expect(store.list({ prefix: "notes/" })).rejects.toThrow(
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

	it("reads the latest of three writes matching the latest history entry", async () => {
		const store = createStore();
		await store.write("notes/versioned", { content: "One" });
		await store.write("notes/versioned", { content: "Two" });
		const third = await store.write("notes/versioned", { content: "Three" });

		const latest = await store.read("notes/versioned");
		const history = await store.history("notes/versioned");

		expect(latest).toEqual(third);
		expect(history[0]).toEqual({
			version: latest!.version,
			updatedAt: latest!.metadata.updatedAt,
		});
	});

	it("reads an old version with its old content and updatedAt", async () => {
		const store = createStore();
		const old = await store.write("notes/versioned", { content: "Old" });
		await store.write("notes/versioned", { content: "New" });

		const revision = await store.read("notes/versioned", {
			version: old.version,
		});

		expect(revision).toMatchObject({
			content: "Old",
			metadata: { updatedAt: old.metadata.updatedAt },
		});
	});

	it("returns null for an unknown version", async () => {
		const store = createStore();
		await store.write("notes/versioned", { content: "Known" });

		await expect(
			store.read("notes/versioned", { version: "junk" }),
		).resolves.toBeNull();
	});

	it("returns null when reading a version from a missing path", async () => {
		const store = createStore();

		await expect(
			store.read("notes/missing", { version: "1" }),
		).resolves.toBeNull();
	});

	it("returns history newest-first with distinct versions", async () => {
		const store = createStore();
		const first = await store.write("notes/versioned", { content: "One" });
		const second = await store.write("notes/versioned", { content: "Two" });
		const third = await store.write("notes/versioned", { content: "Three" });

		const history = await store.history("notes/versioned");

		expect(history.map(({ version }) => version)).toEqual([
			third.version,
			second.version,
			first.version,
		]);
		expect(new Set(history.map(({ version }) => version)).size).toBe(3);
	});

	it("returns an empty history for a missing path", async () => {
		const store = createStore();

		await expect(store.history("notes/missing")).resolves.toEqual([]);
	});

	it("deletes a document's history", async () => {
		const store = createStore();
		await store.write("notes/versioned", { content: "One" });
		await store.write("notes/versioned", { content: "Two" });

		await store.delete("notes/versioned");

		await expect(store.history("notes/versioned")).resolves.toEqual([]);
	});

	it("starts fresh history when writing again after delete", async () => {
		const store = createStore();
		const deleted = await store.write("notes/versioned", { content: "Old" });
		await store.delete("notes/versioned");
		const fresh = await store.write("notes/versioned", { content: "Fresh" });

		const history = await store.history("notes/versioned");

		expect(history).toEqual([
			{ version: fresh.version, updatedAt: fresh.metadata.updatedAt },
		]);
		expect(fresh.metadata.createdAt).not.toBe(deleted.metadata.createdAt);
	});

	it("filters prefixes by complete path segments", async () => {
		const store = createStore();
		await store.write("briefs/one", { content: "One" });
		await store.write("briefs/2026/two", { content: "Two" });
		await store.write("briefs-old/three", { content: "Three" });

		const listed = await store.list({ prefix: "briefs" });

		expect(listed.map(({ path }) => path)).toEqual([
			"briefs/2026/two",
			"briefs/one",
		]);
	});

	it("lists only direct children when recursive is false", async () => {
		const store = createStore();
		await store.write("briefs/direct", { content: "Direct" });
		await store.write("briefs/2026/nested", { content: "Nested" });

		const listed = await store.list({ prefix: "briefs", recursive: false });

		expect(listed.map(({ path }) => path)).toEqual(["briefs/direct"]);
	});

	it("orders by updatedAt newest-first", async () => {
		const store = createStore();
		await store.write("notes/first", { content: "First" });
		await store.write("notes/second", { content: "Second" });
		await store.write("notes/third", { content: "Third" });

		const listed = await store.list({ orderBy: "updatedAt" });

		expect(listed.map(({ path }) => path)).toEqual([
			"notes/third",
			"notes/second",
			"notes/first",
		]);
	});

	it("limits listed documents", async () => {
		const store = createStore();
		await store.write("notes/c", { content: "C" });
		await store.write("notes/a", { content: "A" });
		await store.write("notes/b", { content: "B" });

		const listed = await store.list({ limit: 2 });

		expect(listed.map(({ path }) => path)).toEqual(["notes/a", "notes/b"]);
	});

	it("keeps bare list behavior", async () => {
		const store = createStore();
		await store.write("notes/z", { content: "Z" });
		await store.write("briefs/a", { content: "A" });

		const listed = await store.list();

		expect(listed.map(({ path }) => path)).toEqual(["briefs/a", "notes/z"]);
		expect(listed.every((doc) => !("content" in doc))).toBe(true);
	});
	it("rejects single-dot path segments", async () => {
		const store = createStore();
		await expect(store.write("notes/./x", { content: "c" })).rejects.toThrow(
			"Invalid notebook path",
		);
	});

	it("reports whether delete removed anything", async () => {
		const store = createStore();
		await store.write("notes/a", { content: "c" });
		expect(await store.delete("notes/a")).toBe(true);
		expect(await store.delete("notes/a")).toBe(false);
		expect(await store.delete("notes/missing")).toBe(false);
	});

	it("includes a page at the prefix itself in non-recursive listings", async () => {
		const store = createStore();
		await store.write("briefs", { content: "index page" });
		await store.write("briefs/2026-08-20", { content: "daily" });
		await store.write("briefs/2026/deep", { content: "nested" });
		const direct = await store.list({ prefix: "briefs", recursive: false });
		expect(direct.map((d) => d.path)).toEqual(["briefs", "briefs/2026-08-20"]);
	});

	it("lists only top-level pages when non-recursive without a prefix", async () => {
		const store = createStore();
		await store.write("inbox", { content: "a" });
		await store.write("notes/a", { content: "b" });
		const top = await store.list({ recursive: false });
		expect(top.map((d) => d.path)).toEqual(["inbox"]);
	});

	it("stores caller metadata beside the reserved keys", async () => {
		const store = createStore();

		const written = await store.write("notes/tagged", {
			content: "Tagged",
			title: "Tagged note",
			metadata: { source: "chat", tags: ["memory"], pinned: true },
		});
		const read = await store.read("notes/tagged");

		expect(written.metadata).toEqual({
			title: "Tagged note",
			createdAt: written.metadata.createdAt,
			updatedAt: written.metadata.updatedAt,
			source: "chat",
			tags: ["memory"],
			pinned: true,
		});
		expect(read!.metadata).toEqual(written.metadata);
	});

	it("inherits metadata when the field is omitted", async () => {
		const store = createStore();
		await store.write("notes/tagged", {
			content: "First",
			metadata: { source: "chat" },
		});

		const rewritten = await store.write("notes/tagged", { content: "Second" });

		expect(rewritten.metadata.source).toBe("chat");
	});

	it("clears metadata with an empty object", async () => {
		const store = createStore();
		await store.write("notes/tagged", {
			content: "First",
			metadata: { source: "chat" },
		});

		const cleared = await store.write("notes/tagged", {
			content: "Second",
			metadata: {},
		});

		expect(cleared.metadata).toEqual({
			title: "tagged",
			createdAt: cleared.metadata.createdAt,
			updatedAt: cleared.metadata.updatedAt,
		});
	});

	it("rejects reserved metadata keys", async () => {
		const store = createStore();

		await expect(
			store.write("notes/tagged", {
				content: "Reserved",
				metadata: { title: "Sneaky", source: "chat" },
			}),
		).rejects.toThrow("Notebook metadata keys are reserved: title");
	});

	it("rejects metadata over 8 KB", async () => {
		const store = createStore();

		await expect(
			store.write("notes/tagged", {
				content: "Too big",
				metadata: { blob: "x".repeat(8 * 1_024) },
			}),
		).rejects.toThrow("over the 8192-byte limit");
	});
});
