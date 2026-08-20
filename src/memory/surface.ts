import { alreadySurfaced, markSurfaced } from "../conversation";
import type { Env } from "../env";
import { notebookUrl } from "../notebook/links";
import type { NotebookStore } from "../notebook/store";
import { isRelevantMemory, recallMemories } from "./index";

type SurfacedMemory = {
	path: string;
	title: string;
	content: string;
	url: string;
};

export async function surfaceMemories(
	env: Env,
	store: NotebookStore,
	input: { memoryContext: string; conversationId: string },
): Promise<SurfacedMemory[]> {
	try {
		const { memoryContext, conversationId } = input;
		const candidates = (await recallMemories(env, store, memoryContext))
			.filter(isRelevantMemory)
			.slice(0, 3);
		const surfaced = await Promise.all(
			candidates.map(({ path }) => alreadySurfaced(env, conversationId, path)),
		);
		const unsurfaced = candidates.filter((_, index) => !surfaced[index]);

		if (unsurfaced.length > 0) {
			await markSurfaced(
				env,
				conversationId,
				unsurfaced.map(({ path }) => path),
			);
		}

		return unsurfaced.map(({ path, title, content }) => ({
			path,
			title,
			content,
			url: notebookUrl(path),
		}));
	} catch (error) {
		console.error("ayo memory surfacing failed", error);
		return [];
	}
}
