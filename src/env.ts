import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { NotebookStore } from "./notebook/store";

type AiBinding = {
	run(
		model: string,
		input: { text: string[] },
	): Promise<{ data: number[][] }>;
	run(
		model: string,
		input: Record<string, unknown>,
		options?: {
			gateway: { id: string; skipCache?: boolean; cacheTtl?: number };
		},
	): Promise<unknown>;
	aiGatewayLogId?: string | null;
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

type BureauMessageSummary = { id: string } & Record<string, unknown>;
type BureauThread = { messages: BureauMessageSummary[] } & Record<
	string,
	unknown
>;
type BureauRecipient = { address: string; name?: string };

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
	listAccounts(input: Record<string, never>): Promise<unknown[]>;
	listThreads(input: {
		address: string;
		folder?: string;
		starred?: boolean;
		limit?: number;
		before?: string;
		beforeId?: string;
	}): Promise<unknown[]>;
	listMessages(input: {
		address: string;
		folder?: string;
		threadId?: string;
		limit?: number;
		before?: string;
	}): Promise<unknown[]>;
	getThread(input: { address: string; id: string }): Promise<BureauThread>;
	getMessage(input: {
		address: string;
		id: string;
	}): Promise<Record<string, unknown>>;
	moveMessage(input: {
		address: string;
		id: string;
		to: string;
	}): Promise<BureauMessageSummary>;
	setMessageFlags(input: {
		address: string;
		id: string;
		add?: string[];
		remove?: string[];
	}): Promise<BureauMessageSummary>;
	send(input: {
		address: string;
		to?: BureauRecipient[];
		cc?: BureauRecipient[];
		bcc?: BureauRecipient[];
		fromName?: string;
		subject: string;
		text: string;
		html?: string;
		reference?: { id: string; action: "reply" | "replyAll" | "forward" };
	}): Promise<{
		id: string | null;
		threadId: string | null;
		messageId: string;
		rejected: string[];
		warning?: string;
	}>;
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
	AI_GATEWAY_ID?: string;
	BUREAU?: BureauBinding;
	LOADER?: WorkerLoader;
	NOTEBOOK_STORE_FOR_TESTS?: NotebookStore;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	SEARCH_OFFLINE?: string;
	VECTORIZE?: VectorizeBinding;
};
