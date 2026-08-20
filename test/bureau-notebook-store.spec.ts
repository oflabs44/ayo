import { describe, expect, it, vi } from "vitest";
import { BureauNotebookStore } from "../src/notebook/bureau-store";
import { InMemoryNotebookStore } from "../src/notebook/memory-store";
import { getNotebookStore } from "../src/notebook/resolve";
import type { BureauBinding, Env } from "../src/env";

const metadata = {
	title: "Seat preference",
	createdAt: "2026-08-20T10:00:00.000Z",
	updatedAt: "2026-08-21T10:00:00.000Z",
};
const document = {
	path: "memory/aisle-seats",
	version: "version-2",
	metadata,
	content: "I prefer aisle seats.",
};

function createBureauMock() {
	const writeNotebookDoc = vi.fn(
		async (_input: Parameters<BureauBinding["writeNotebookDoc"]>[0]) => ({
			...document,
			sourceUrl: "https://bureau.example/memory/aisle-seats",
		}),
	);
	const readNotebookDoc = vi.fn(
		async (_input: Parameters<BureauBinding["readNotebookDoc"]>[0]) => document,
	);
	const listNotebookDocs = vi.fn(
		async (_input: Parameters<BureauBinding["listNotebookDocs"]>[0]) => [
			{
				path: document.path,
				version: document.version,
				metadata,
			},
		],
	);
	const notebookHistory = vi.fn(
		async (_input: Parameters<BureauBinding["notebookHistory"]>[0]) => [
			{ version: "version-2", updatedAt: metadata.updatedAt },
			{ version: "version-1", updatedAt: metadata.createdAt },
		],
	);
	const deleteNotebookDoc = vi.fn(
		async (_input: Parameters<BureauBinding["deleteNotebookDoc"]>[0]) => true,
	);
	const bureau: BureauBinding = {
		writeNotebookDoc,
		readNotebookDoc,
		listNotebookDocs,
		notebookHistory,
		deleteNotebookDoc,
	};
	return {
		bureau,
		writeNotebookDoc,
		readNotebookDoc,
		listNotebookDocs,
		notebookHistory,
		deleteNotebookDoc,
	};
}

describe("BureauNotebookStore", () => {
	it("delegates writes and maps Bureau documents with source URLs", async () => {
		const { bureau, writeNotebookDoc } = createBureauMock();
		const store = new BureauNotebookStore(bureau);

		const result = await store.write(document.path, {
			content: document.content,
			title: metadata.title,
		});

		expect(writeNotebookDoc).toHaveBeenCalledWith({
			path: document.path,
			content: document.content,
			title: metadata.title,
		});
		expect(result).toEqual({
			path: document.path,
			version: document.version,
			metadata,
			content: document.content,
			sourceUrl: "https://bureau.example/memory/aisle-seats",
		});
	});

	it("delegates versioned reads and omits absent source URLs", async () => {
		const { bureau, readNotebookDoc } = createBureauMock();
		const store = new BureauNotebookStore(bureau);

		const result = await store.read(document.path, { version: "version-1" });

		expect(readNotebookDoc).toHaveBeenCalledWith({
			path: document.path,
			version: "version-1",
		});
		expect(result).toEqual(document);
		expect(result).not.toHaveProperty("sourceUrl");
	});

	it("delegates list options and maps metadata", async () => {
		const { bureau, listNotebookDocs } = createBureauMock();
		const store = new BureauNotebookStore(bureau);
		const query = {
			prefix: "memory",
			recursive: false,
			orderBy: "updatedAt" as const,
			limit: 3,
		};

		const result = await store.list(query);

		expect(listNotebookDocs).toHaveBeenCalledWith(query);
		expect(result).toEqual([
			{
				path: document.path,
				version: document.version,
				metadata,
			},
		]);
	});

	it("delegates history reads and maps revisions", async () => {
		const { bureau, notebookHistory } = createBureauMock();
		const store = new BureauNotebookStore(bureau);

		const result = await store.history(document.path);

		expect(notebookHistory).toHaveBeenCalledWith({ path: document.path });
		expect(result).toEqual([
			{ version: "version-2", updatedAt: metadata.updatedAt },
			{ version: "version-1", updatedAt: metadata.createdAt },
		]);
	});

	it("delegates deletes and preserves Bureau's honest boolean", async () => {
		const { bureau, deleteNotebookDoc } = createBureauMock();
		const store = new BureauNotebookStore(bureau);

		await expect(store.delete(document.path)).resolves.toBe(true);
		expect(deleteNotebookDoc).toHaveBeenCalledWith({ path: document.path });
	});

	it("resolves the test override before the Bureau binding", () => {
		const { bureau } = createBureauMock();
		const override = new InMemoryNotebookStore();

		expect(
			getNotebookStore({
				BUREAU: bureau,
				NOTEBOOK_STORE_FOR_TESTS: override,
			} as unknown as Env),
		).toBe(override);
		expect(
			getNotebookStore({ BUREAU: bureau } as unknown as Env),
		).toBeInstanceOf(BureauNotebookStore);
	});
});
