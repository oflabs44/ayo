import type { Env } from "../env";

// This module is the single authority for Ayo's canonical notebook links.
const BUREAU_NOTEBOOK_BASE_URL = "https://bureau.oflabs.dev/notebook";

function encodeNotebookPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export function notebookUrl(env: Env, path: string): string {
	return `${env.PUBLIC_BASE_URL}/notebook/${path}`;
}

export function bureauNotebookUrl(path: string): string {
	return `${BUREAU_NOTEBOOK_BASE_URL}/${encodeNotebookPath(path)}`;
}
