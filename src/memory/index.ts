import type { Env } from "../env";
import type { NotebookDoc, NotebookStore } from "../notebook/store";
import {
	embedTexts,
	EMBEDDING_MAX_INPUT_CHARS,
	identityBodyScore,
	RRF_CONSTANT,
} from "../search-support";

export const MEMORY_INDEX_STATE_KEY = "memory:index-state";
const MEMORY_NAMESPACE = "memories";

type MemoryIndexState = Record<string, string>;

export type MemoryRecallResult = {
	path: string;
	title: string;
	content: string;
	updatedAt: string;
	score: number;
};

export function buildMemoryEmbedText(doc: NotebookDoc): string {
	return `${doc.metadata.title}\n${doc.content}`.slice(
		0,
		EMBEDDING_MAX_INPUT_CHARS,
	);
}

function isOffline(env: Env): boolean {
	return env.SEARCH_OFFLINE === "true" || !env.AI || !env.VECTORIZE;
}

function parseIndexState(value: string | null): MemoryIndexState {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}

export async function removeMemoryFromIndex(
	env: Env,
	path: string,
): Promise<void> {
	if (env.VECTORIZE) {
		await env.VECTORIZE.deleteByIds([path]);
	}

	const state = parseIndexState(
		await env.OAUTH_KV.get(MEMORY_INDEX_STATE_KEY),
	);
	if (!(path in state)) return;
	delete state[path];
	await env.OAUTH_KV.put(MEMORY_INDEX_STATE_KEY, JSON.stringify(state));
}

export async function syncMemoryIndex(
	env: Env,
	store: NotebookStore,
): Promise<void> {
	if (isOffline(env)) return;

	const inventory = await store.list({ prefix: "memory" });
	const previousState = parseIndexState(
		await env.OAUTH_KV.get(MEMORY_INDEX_STATE_KEY),
	);
	const currentState = Object.fromEntries(
		inventory.map(({ path, version }) => [path, version]),
	);
	const changed = inventory.filter(
		({ path, version }) => previousState[path] !== version,
	);
	const vanished = Object.keys(previousState).filter(
		(path) => currentState[path] === undefined,
	);

	if (changed.length > 0) {
		const docs = await Promise.all(
			changed.map(async ({ path, version }) => {
				const doc = await store.read(path, { version });
				if (!doc) {
					throw new Error(`Memory disappeared during index sync: ${path}`);
				}
				return doc;
			}),
		);
		const embeddings = await embedTexts(
			env,
			docs.map(buildMemoryEmbedText),
		);
		await env.VECTORIZE!.upsert(
			docs.map((doc, index) => ({
				id: doc.path,
				values: embeddings[index]!,
				namespace: MEMORY_NAMESPACE,
			})),
		);
	}

	if (vanished.length > 0) {
		await env.VECTORIZE!.deleteByIds(vanished);
	}

	await env.OAUTH_KV.put(
		MEMORY_INDEX_STATE_KEY,
		JSON.stringify(currentState),
	);
}

function rrfScores(rankings: string[][]): Map<string, number> {
	const scores = new Map<string, number>();
	for (const ranking of rankings) {
		ranking.forEach((path, index) => {
			scores.set(
				path,
				(scores.get(path) ?? 0) + 1 / (RRF_CONSTANT + index + 1),
			);
		});
	}
	return scores;
}

export async function recallMemories(
	env: Env,
	store: NotebookStore,
	query: string,
	limit = 5,
): Promise<MemoryRecallResult[]> {
	const offline = isOffline(env);
	if (!offline) {
		await syncMemoryIndex(env, store);
	}

	const inventory = await store.list({ prefix: "memory" });
	const docs = (
		await Promise.all(
			inventory.map(({ path, version }) => store.read(path, { version })),
		)
	).filter((doc): doc is NotebookDoc => doc !== null);
	const docsByPath = new Map(docs.map((doc) => [doc.path, doc]));
	const lexicalRanking = docs
		.map((doc) => ({
			path: doc.path,
			score: identityBodyScore(query, doc.metadata.title, doc.content),
		}))
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score)
		.map(({ path }) => path);

	let vectorRanking: string[] = [];
	if (!offline && docs.length > 0 && limit > 0) {
		const [queryEmbedding] = await embedTexts(env, [query]);
		const result = await env.VECTORIZE!.query(queryEmbedding!, {
			topK: limit,
			namespace: MEMORY_NAMESPACE,
		});
		vectorRanking = result.matches.flatMap(({ id }) =>
			docsByPath.has(id) ? [id] : [],
		);
	}

	return [...rrfScores([lexicalRanking, vectorRanking]).entries()]
		.sort((left, right) => right[1] - left[1])
		.slice(0, Math.max(0, limit))
		.flatMap(([path, score]) => {
			const doc = docsByPath.get(path);
			return doc
				? [
						{
							path,
							title: doc.metadata.title,
							content: doc.content,
							updatedAt: doc.metadata.updatedAt,
							score,
						},
					]
				: [];
		});
}
