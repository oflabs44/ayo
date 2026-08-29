import type { Env } from "./env";

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBEDDING_MAX_INPUT_CHARS = 2_000;
export const RRF_CONSTANT = 60;

function tokenize(value: string): Set<string> {
	// Possessives shed shrapnel ("timi's" -> "s") that creates false overlap;
	// strip the suffix instead of dropping all single characters, which would
	// collapse meaningful labels like "plan a" vs "plan b".
	return new Set(
		value
			.toLowerCase()
			.replaceAll(/['’]s\b/g, "")
			.match(/[a-z0-9]+/g) ?? [],
	);
}

/**
 * Uniform weighting counts "my" and "mailbox" the same, so a question-shaped
 * query is decided by its scaffolding: "what are my mail folders" matched
 * accounts_list on `my` + `mail` and beat the capability that owns `folders`,
 * and "remove that mail label" was won by `that`.
 *
 * Inverse document frequency does not fix this. Across 45 terse capability
 * descriptions a function word like `that` or `browse` is genuinely rarer than
 * `mail`, so rarity weighting promotes exactly the tokens that carry no intent.
 * Function words are a closed class, so name them instead of inferring them.
 *
 * Deliberately excludes verbs that distinguish one capability from another -
 * show, list, find, read, send, move, make, new - and words that are content in
 * this domain, such as "next" for a calendar query.
 */
const STOPWORDS = new Set([
	"a", "all", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
	"can", "could", "did", "do", "does", "for", "from", "get", "had", "has",
	"have", "he", "her", "him", "his", "how", "i", "if", "in", "into", "is",
	"it", "its", "me", "mine", "my", "of", "on", "or", "our", "please", "she",
	"should", "so", "some", "that", "the", "their", "them", "then", "there",
	"these", "they", "this", "those", "to", "us", "was", "we", "were", "what",
	"when", "where", "which", "who", "whom", "whose", "why", "will", "with",
	"would", "you", "your", "yours",
]);

// A calibration knob, midpoint of the band the golden queries accept (0.45 to
// 0.9; 1.0 loses the mail-folder queries, 0.35 loses "remember to renew my
// passport", where "to" is what separates a task from a memory). Deliberately
// not zero: dropping function words outright costs those distinctions, and a
// query that is nothing but function words should still rank something rather
// than collapse to an empty result.
const STOPWORD_WEIGHT = 0.65;

function tokenOverlap(
	queryTokens: Set<string>,
	document: string,
	downweightStopwords: boolean,
): number {
	const documentTokens = tokenize(document);
	let matched = 0;
	let total = 0;
	for (const token of queryTokens) {
		const weight =
			downweightStopwords && STOPWORDS.has(token) ? STOPWORD_WEIGHT : 1;
		total += weight;
		if (documentTokens.has(token)) {
			matched += weight;
		}
	}
	return total === 0 ? 0 : matched / total;
}

/**
 * The weighting is opt-in because this score is not only a ranking signal:
 * memory recall compares it against DUPLICATE_LEXICAL_THRESHOLD and
 * RELEVANT_LEXICAL_THRESHOLD, and reweighting would move both gates without
 * anyone recalibrating them. Callers that only rank should opt in.
 */
export function identityBodyScore(
	query: string,
	identity: string,
	body: string,
	downweightStopwords = false,
): number {
	const queryTokens = tokenize(query);
	return (
		0.7 * tokenOverlap(queryTokens, body, downweightStopwords) +
		0.3 * tokenOverlap(queryTokens, identity, downweightStopwords)
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
