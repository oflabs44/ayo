import type { Env } from "../env";

// Single authority for Ayo's document upload and download route URLs.
export function documentUploadUrl(env: Env, token: string): string {
	return `${env.PUBLIC_BASE_URL}/documents/upload/${token}`;
}

export function documentFileUrl(env: Env, token: string): string {
	return `${env.PUBLIC_BASE_URL}/documents/file/${token}`;
}
