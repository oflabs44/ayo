import type { Env } from "../env";
import { BureauNotebookStore } from "./bureau-store";
import type { NotebookStore } from "./store";

export function getNotebookStore(env: Env): NotebookStore | null {
	if (env.NOTEBOOK_STORE_FOR_TESTS) return env.NOTEBOOK_STORE_FOR_TESTS;
	return env.BUREAU ? new BureauNotebookStore(env.BUREAU) : null;
}
