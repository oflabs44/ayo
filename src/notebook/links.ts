// This module is the single authority for Ayo's canonical notebook links.
const NOTEBOOK_BASE_URL = "https://ayo.oflabs.dev/notebook";
const BUREAU_NOTEBOOK_BASE_URL = "https://bureau.oflabs.dev/notebook";

function encodeNotebookPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export function notebookUrl(path: string): string {
	return `${NOTEBOOK_BASE_URL}/${path}`;
}

export function bureauNotebookUrl(path: string): string {
	return `${BUREAU_NOTEBOOK_BASE_URL}/${encodeNotebookPath(path)}`;
}
