import type { Env } from "./env";

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBEDDING_MAX_INPUT_CHARS = 2_000;
export const RRF_CONSTANT = 60;

function tokenize(value: string): Set<string> {
	return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function tokenOverlap(queryTokens: Set<string>, document: string): number {
	if (queryTokens.size === 0) {
		return 0;
	}

	const documentTokens = tokenize(document);
	let overlap = 0;
	for (const token of queryTokens) {
		if (documentTokens.has(token)) {
			overlap += 1;
		}
	}
	return overlap / queryTokens.size;
}

export function identityBodyScore(
	query: string,
	identity: string,
	body: string,
): number {
	const queryTokens = tokenize(query);
	return (
		0.7 * tokenOverlap(queryTokens, body) +
		0.3 * tokenOverlap(queryTokens, identity)
	);
}

export async function embedTexts(
	env: Env,
	texts: string[],
): Promise<number[][]> {
	if (!env.AI) {
		throw new Error("Workers AI binding is unavailable");
	}
	const response = await env.AI.run(EMBEDDING_MODEL, {
		text: texts.map((text) => text.slice(0, EMBEDDING_MAX_INPUT_CHARS)),
	});
	if (response.data.length !== texts.length) {
		throw new Error(
			`Embedding returned ${response.data.length} vectors for ${texts.length} texts`,
		);
	}
	return response.data;
}
