import type { Env } from "../env";
import type { NotebookStore } from "./store";

export function getNotebookStore(env: Env): NotebookStore | null {
	return env.NOTEBOOK_STORE_FOR_TESTS ?? null;
}
