import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { NotebookStore } from "./notebook/store";

type AiBinding = {
	run(
		model: string,
		input: { text: string[] },
	): Promise<{ data: number[][] }>;
};

type VectorizeBinding = {
	upsert(
		vectors: Array<{ id: string; values: number[]; namespace: string }>,
	): Promise<unknown>;
	query(
		vector: number[],
		options: { topK: number; namespace: string },
	): Promise<{ matches: Array<{ id: string; score: number }> }>;
};

export type OwnerProps = {
	email: string;
	name: string;
	sub: string;
};

export type Env = {
	ACCESS_OIDC_CLIENT_ID: string;
	ACCESS_OIDC_CLIENT_SECRET: string;
	ACCESS_OIDC_ISSUER: string;
	AI?: AiBinding;
	LOADER?: WorkerLoader;
	NOTEBOOK_STORE_FOR_TESTS?: NotebookStore;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	SEARCH_OFFLINE?: string;
	VECTORIZE?: VectorizeBinding;
};
