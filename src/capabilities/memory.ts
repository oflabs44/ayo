import { z } from "zod";
import {
	isSimilarMemory,
	recallMemories,
	removeMemoryFromIndex,
	syncMemoryIndex,
} from "../memory";
import { notebookUrl } from "../notebook/links";
import { getNotebookStore } from "../notebook/resolve";
import { isValidNotebookPath, type NotebookStore } from "../notebook/store";
import type { Capability } from "./index";

const BACKEND_NOT_CONFIGURED = "The notebook backend is not configured.";
const MAX_SLUG_LENGTH = 48;

const memoryPathSchema = z
	.string()
	.refine(isValidNotebookPath, { message: "Invalid notebook path" })
	.refine((path) => path.startsWith("memory/"), {
		message: "Memory paths must be under memory/",
	});
const rememberInputSchema = z.object({
	content: z.string().refine((content) => content.trim().length > 0, {
		message: "Memory content cannot be empty",
	}),
	path: memoryPathSchema.optional(),
	force: z.boolean().optional(),
});
const recallInputSchema = z.object({
	query: z.string().refine((query) => query.trim().length > 0, {
		message: "Recall query cannot be empty",
	}),
	limit: z.number().int().positive().optional(),
});
const forgetInputSchema = z.object({ path: memoryPathSchema });

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function slugify(content: string): string {
	return (
		content
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/['’]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, MAX_SLUG_LENGTH)
			.replace(/-+$/g, "") || "memory"
	);
}

async function availableMemoryPath(
	store: NotebookStore,
	content: string,
): Promise<string> {
	const basePath = `memory/${slugify(content)}`;
	let path = basePath;
	let suffix = 2;
	while (await store.read(path)) {
		path = `${basePath}-${suffix}`;
		suffix += 1;
	}
	return path;
}

export const memory: Capability[] = [
	{
		name: "memory_remember",
		description:
			"Remember or update topic-sized notes about me, never single-sentence memories; when creating one, prefer subject-named paths (memory/preferences/sports) rather than sentence-derived paths. Read memory/readme with notebook_read for sections and filing rules",
		inputSchema: rememberInputSchema,
		keywords: [
			"remember this",
			"store preference",
			"dietary preference",
			"update topic note",
			"group related facts",
			"subject-based memory path",
			"memory/readme filing rules",
		],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { content, path, force } = input as z.infer<
				typeof rememberInputSchema
			>;
			const related = (await recallMemories(env, store, content))
				.filter((result) => isSimilarMemory(result) && result.path !== path)
				.map(({ path, title, content, updatedAt: _updatedAt }) => ({
					path,
					title,
					content,
					url: notebookUrl(env, path),
				}));
			if (related.length > 0 && !force) {
				return {
					written: false,
					related,
					message:
						"A related memory exists. The right move is usually to update it - pass its path and fold the new fact in. Use force: true only for a genuinely unrelated fact.",
				};
			}

			const resolvedPath = path ?? (await availableMemoryPath(store, content));
			const doc = await store.write(resolvedPath, { content });
			await syncMemoryIndex(env, store);
			const { content: _content, ...metadata } = doc;
			return { written: true, ...metadata, url: notebookUrl(env, doc.path) };
		},
	},
	{
		name: "memory_recall",
		description: "Recall what Ayo knows about a topic",
		inputSchema: recallInputSchema,
		keywords: [
			"knowledge about me",
			"remembered facts",
			"find a memory",
			"my preferences",
		],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { query, limit } = input as z.infer<typeof recallInputSchema>;
			return (await recallMemories(env, store, query, limit)).map(
				({ path, title, content, updatedAt }) => ({
					path,
					title,
					content,
					updatedAt,
					url: notebookUrl(env, path),
				}),
			);
		},
	},
	{
		name: "memory_forget",
		description: "Forget a remembered fact",
		inputSchema: forgetInputSchema,
		keywords: [
			"forget this",
			"forget what I said",
			"delete memory",
			"remove remembered fact",
			"erase preference",
		],
		handler: async (input, { env }) => {
			const store = getNotebookStore(env);
			if (!store) return unavailable();
			const { path } = input as z.infer<typeof forgetInputSchema>;
			if (!(await store.delete(path))) {
				return { ok: false, error: `No memory exists at ${path}` };
			}
			await removeMemoryFromIndex(env, path);
			return { ok: true };
		},
	},
];
