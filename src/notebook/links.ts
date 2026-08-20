// This module is the single authority for Ayo's canonical notebook links.
const NOTEBOOK_BASE_URL = "https://ayo.oflabs.dev/notebook";

export function notebookUrl(path: string): string {
	return `${NOTEBOOK_BASE_URL}/${path}`;
}
