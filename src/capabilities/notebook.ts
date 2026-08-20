import { z } from "zod";
import { notebookUrl } from "../notebook/links";
import { getNotebookStore } from "../notebook/resolve";
import { isValidNotebookPath } from "../notebook/store";
import type { Capability } from "./index";

const BACKEND_NOT_CONFIGURED = "The notebook backend is not configured.";

const pathSchema = z
	.string()
	.refine(isValidNotebookPath, { message: "Invalid notebook path" });

const writeInputSchema = z.object({
	path: pathSchema,
	content: z.string(),
	title: z.string().optional(),
});
const readInputSchema = z.object({
	path: pathSchema,
	version: z.string().optional(),
});
const listInputSchema = z.object({
	prefix: pathSchema.optional(),
	recursive: z.boolean().optional(),
	orderBy: z.enum(["path", "updatedAt"]).optional(),
	limit: z.number().int().positive().optional(),
});
const pathInputSchema = z.object({ path: pathSchema });

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function withCanonicalUrl<Doc extends { path: string }>(doc: Doc) {
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
			const { path, version } = input as z.infer<typeof readInputSchema>;
			const doc = await store.read(path, { version });
			return doc ? withCanonicalUrl(doc) : null;
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
			"recent notes",
		],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const query = input as z.infer<typeof listInputSchema>;
			return (await store.list(query)).map(withCanonicalUrl);
		},
	},
	{
		name: "notebook_delete",
		description: "Delete a page from the notebook",
		inputSchema: pathInputSchema,
		keywords: ["delete note", "remove page", "erase note", "discard page"],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { path } = input as z.infer<typeof pathInputSchema>;
			const deleted = await store.delete(path);
			return deleted
				? { ok: true }
				: { ok: false, error: `No page exists at ${path}` };
		},
	},
	{
		name: "notebook_history",
		description: "See a page's past versions in the notebook",
		inputSchema: pathInputSchema,
		keywords: [
			"previous version",
			"previous versions",
			"what did it say before",
			"page history",
			"revision history",
		],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { path } = input as z.infer<typeof pathInputSchema>;
			return store.history(path);
		},
	},
];
