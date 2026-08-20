import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { NotebookStore } from "./notebook/store";

type AiBinding = {
	run(
		model: string,
		input: { text: string[] },
	): Promise<{ data: number[][] }>;
};

type BureauNotebookMetadata = {
	title: string;
	createdAt: string;
	updatedAt: string;
};

type BureauNotebookDocMeta = {
	path: string;
	version: string;
	metadata: BureauNotebookMetadata;
};

type BureauNotebookDoc = BureauNotebookDocMeta & { content: string };

export type BureauBinding = {
	writeNotebookDoc(input: {
		path: string;
		content: string;
		title?: string;
	}): Promise<BureauNotebookDoc>;
	readNotebookDoc(input: {
		path: string;
		version?: string;
	}): Promise<BureauNotebookDoc | null>;
	listNotebookDocs(input: {
		prefix?: string;
		recursive?: boolean;
		orderBy?: "path" | "updatedAt";
		limit?: number;
	}): Promise<BureauNotebookDocMeta[]>;
	notebookHistory(input: {
		path: string;
	}): Promise<Array<{ version: string; updatedAt: string }>>;
	deleteNotebookDoc(input: { path: string }): Promise<boolean>;
};

type VectorizeBinding = {
	deleteByIds(ids: string[]): Promise<unknown>;
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
	BUREAU?: BureauBinding;
	LOADER?: WorkerLoader;
	NOTEBOOK_STORE_FOR_TESTS?: NotebookStore;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	SEARCH_OFFLINE?: string;
	VECTORIZE?: VectorizeBinding;
};
