import type { Env } from "../env";
import type { NotebookStore } from "../notebook/store";
import { isRelevantMemory, recallMemories } from "./index";

// No hide-after-first-show: a suppressed repeat is lost for good when the host
// compacts away the earlier tool result. Cheap one-liners are repeated instead,
// and two slots keep a rank-two memory visible. (Kody ADR 0033 lab evidence.)
const SURFACED_MEMORY_LIMIT = 2;
const SUMMARY_LENGTH = 80;

type SurfacedMemory = {
	path: string;
	line: string;
};

function summarize(content: string): string {
	const collapsed = content.replaceAll(/\s+/g, " ").trim();
	return collapsed.length > SUMMARY_LENGTH
		? `${collapsed.slice(0, SUMMARY_LENGTH - 1)}…`
		: collapsed;
}

export async function surfaceMemories(
	env: Env,
	store: NotebookStore,
	memoryContext: string,
): Promise<SurfacedMemory[]> {
	try {
		const candidates = (await recallMemories(env, store, memoryContext))
			.filter(isRelevantMemory)
			.slice(0, SURFACED_MEMORY_LIMIT);
		return candidates.map(({ path, title, content }) => ({
			path,
			line: summarize(`${title} — ${content}`),
		}));
	} catch (error) {
		console.error("ayo memory surfacing failed", error);
		return [];
	}
}
