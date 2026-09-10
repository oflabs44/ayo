// Single authority for Ayo's document upload and download route URLs.
const DOCUMENTS_BASE_URL = "https://ayo.oflabs.dev/documents";

export function documentUploadUrl(token: string): string {
	return `${DOCUMENTS_BASE_URL}/upload/${token}`;
}

export function documentFileUrl(token: string): string {
	return `${DOCUMENTS_BASE_URL}/file/${token}`;
}
