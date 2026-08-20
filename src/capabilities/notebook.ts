import { z } from "zod";
import { notebookUrl } from "../notebook/links";
import { getNotebookStore } from "../notebook/resolve";
import type { NotebookDocMeta } from "../notebook/store";
import type { Capability } from "./index";

const VALID_PATH_CHARACTERS = /^[a-z0-9_./-]+$/;
const BACKEND_NOT_CONFIGURED = "The notebook backend is not configured.";

const pathSchema = z
	.string()
	.min(1)
	.regex(VALID_PATH_CHARACTERS)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.endsWith("/") &&
			path.split("/").every((segment) => segment && segment !== ".."),
		{ message: "Invalid notebook path" },
	);

const writeInputSchema = z.object({
	path: pathSchema,
	content: z.string(),
	title: z.string().optional(),
});
const readInputSchema = z.object({ path: pathSchema });
const listInputSchema = z.object({ prefix: pathSchema.optional() });
const deleteInputSchema = z.object({ path: pathSchema });

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function withCanonicalUrl(doc: NotebookDocMeta) {
	return { ...doc, url: notebookUrl(doc.path) };
}

export const notebook: Capability[] = [
	{
		name: "notebook_write",
		description: "Write or update a page in the notebook and get its link",
		inputSchema: writeInputSchema,
		keywords: [
			"write down",
			"note",
			"draft",
			"save a page",
			"jot down",
			"update a page",
		],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { path, content, title } = input as z.infer<
				typeof writeInputSchema
			>;
			const doc = await store.write(path, { content, title });
			const { content: _content, ...metadata } = doc;
			return withCanonicalUrl(metadata);
		},
	},
	{
		name: "notebook_read",
		description: "Read a page from the notebook and get its link",
		inputSchema: readInputSchema,
		keywords: ["read a note", "open a page", "show page", "read brief"],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { path } = input as z.infer<typeof readInputSchema>;
			const doc = await store.read(path);
			return doc ? { ...doc, url: notebookUrl(doc.path) } : null;
		},
	},
	{
		name: "notebook_list",
		description: "List pages in the notebook and get their links",
		inputSchema: listInputSchema,
		keywords: [
			"show notes",
			"list pages",
			"browse notebook",
			"notebook pages",
		],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { prefix } = input as z.infer<typeof listInputSchema>;
			return (await store.list(prefix)).map(withCanonicalUrl);
		},
	},
	{
		name: "notebook_delete",
		description: "Delete a page from the notebook",
		inputSchema: deleteInputSchema,
		keywords: ["delete note", "remove page", "erase note", "discard page"],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { path } = input as z.infer<typeof deleteInputSchema>;
			await store.delete(path);
			return { ok: true };
		},
	},
];
