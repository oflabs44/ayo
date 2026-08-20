import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notebook } from "../src/capabilities/notebook";
import type { Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";
import { InMemoryNotebookStore } from "../src/notebook/memory-store";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

function createDispatch(store = new InMemoryNotebookStore()) {
	const env = { NOTEBOOK_STORE_FOR_TESTS: store } as Env;
	return { dispatch: buildDispatchTable(notebook, env, props), store };
}

afterEach(() => vi.restoreAllMocks());

describe("notebook capabilities", () => {
	it("writes and reads a page with its canonical URL", async () => {
		const store = new InMemoryNotebookStore();
		const write = store.write.bind(store);
		vi.spyOn(store, "write").mockImplementation(async (...args) => ({
			...(await write(...args)),
			sourceUrl: "https://source.example/notes/aisle-seats",
		}));
		const { dispatch } = createDispatch(store);

		const written = await dispatch.notebook_write!({
			path: "notes/aisle-seats",
			content: "I prefer aisle seats.",
			title: "Seat preference",
		});
		const read = await dispatch.notebook_read!({ path: "notes/aisle-seats" });

		expect(written).toMatchObject({
			path: "notes/aisle-seats",
			metadata: { title: "Seat preference" },
			sourceUrl: "https://source.example/notes/aisle-seats",
			url: "https://ayo.oflabs.dev/notebook/notes/aisle-seats",
		});
		expect(written).not.toHaveProperty("content");
		expect(read).toMatchObject({
			path: "notes/aisle-seats",
			content: "I prefer aisle seats.",
			metadata: { title: "Seat preference" },
			url: "https://ayo.oflabs.dev/notebook/notes/aisle-seats",
		});
	});

	it("reads a previous version and lists page history", async () => {
		const { dispatch } = createDispatch();
		const first = (await dispatch.notebook_write!({
			path: "briefs/versioned",
			content: "First",
		})) as { version: string };
		const second = (await dispatch.notebook_write!({
			path: "briefs/versioned",
			content: "Second",
		})) as { version: string };

		const old = await dispatch.notebook_read!({
			path: "briefs/versioned",
			version: first.version,
		});
		const history = await dispatch.notebook_history!({
			path: "briefs/versioned",
		});

		expect(old).toMatchObject({ content: "First", version: first.version });
		expect(history).toEqual([
			expect.objectContaining({ version: second.version }),
			expect.objectContaining({ version: first.version }),
		]);
	});

	it("lists pages under a prefix with canonical URLs", async () => {
		const { dispatch } = createDispatch();
		await dispatch.notebook_write!({ path: "notes/z-last", content: "Z" });
		await dispatch.notebook_write!({
			path: "briefs/ignored",
			content: "Brief",
		});
		await dispatch.notebook_write!({ path: "notes/a-first", content: "A" });

		const listed = (await dispatch.notebook_list!({ prefix: "notes" })) as Array<{
			path: string;
			url: string;
		}>;

		expect(listed.map(({ path }) => path)).toEqual([
			"notes/a-first",
			"notes/z-last",
		]);
		expect(listed.map(({ url }) => url)).toEqual([
			"https://ayo.oflabs.dev/notebook/notes/a-first",
			"https://ayo.oflabs.dev/notebook/notes/z-last",
		]);
		expect(listed.every((doc) => !("content" in doc))).toBe(true);
	});

	it("passes richer list options to the store", async () => {
		const { dispatch } = createDispatch();
		await dispatch.notebook_write!({ path: "notes/older", content: "Old" });
		await dispatch.notebook_write!({ path: "notes/newer", content: "New" });
		await dispatch.notebook_write!({
			path: "notes/2026/nested",
			content: "Nested",
		});

		const listed = (await dispatch.notebook_list!({
			prefix: "notes",
			recursive: false,
			orderBy: "updatedAt",
			limit: 1,
		})) as Array<{ path: string }>;

		expect(listed.map(({ path }) => path)).toEqual(["notes/newer"]);
	});

	it("deletes a page", async () => {
		const { dispatch } = createDispatch();
		await dispatch.notebook_write!({ path: "notes/delete-me", content: "Gone" });

		await expect(
			dispatch.notebook_delete!({ path: "notes/delete-me" }),
		).resolves.toEqual({ ok: true });
		await expect(
			dispatch.notebook_read!({ path: "notes/delete-me" }),
		).resolves.toBeNull();
	});

	it.each([
		["notebook_write", { path: "notes/new", content: "New" }],
		["notebook_read", { path: "notes/new" }],
		["notebook_list", {}],
		["notebook_delete", { path: "notes/new" }],
		["notebook_history", { path: "notes/new" }],
	] as const)("returns a structured error from %s without a backend", async (name, input) => {
		const dispatch = buildDispatchTable(notebook, {} as Env, props);

		await expect(dispatch[name]!(input)).resolves.toEqual({
			error: "The notebook backend is not configured.",
		});
	});

	it("rejects invalid notebook paths before calling the store", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { dispatch } = createDispatch();

		await expect(
			dispatch.notebook_read!({ path: "notes/../secret" }),
		).rejects.toBeInstanceOf(z.ZodError);
	});
});
