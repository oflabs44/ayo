import { z } from "zod";
import {
	capabilities,
	capabilityRegistry,
	type RegisteredCapability,
} from "./capabilities/index";
import type { Env } from "./env";
import {
	embedTexts,
	identityBodyScore,
	RRF_CONSTANT,
} from "./search-support";
export {
	embedTexts,
	EMBEDDING_MAX_INPUT_CHARS,
	EMBEDDING_MODEL,
	identityBodyScore,
	RRF_CONSTANT,
} from "./search-support";

const CAPABILITY_NAMESPACE = "capabilities";
const CONTENT_STAMP_KEY = "search:capabilities:content-stamp";
const VECTOR_ID_PREFIX = "capability:";
const OVERVIEW_QUERIES = new Set(["what can you do"]);
// Every match carries its full input schema. The semantic ranking covers the
// whole registry, so an uncapped result is the whole registry on every query.
const MAX_MATCHES = 10;

function callExample(capability: RegisteredCapability): string {
	return `await ayo.${capability.name}({})`;
}

function capabilityText(capability: RegisteredCapability): string {
	return [
		capability.name,
		capability.domain,
		capability.description,
		...(capability.keywords ?? []),
	].join("\n");
}

// Precomputed once: the registry is static, and rebuilding these strings per
// query was the old lexicalScore's only real cost.
const lexicalIndex = capabilities.map((capability) => ({
	capability,
	body: [
		capability.description,
		...(capability.keywords ?? []),
		capability.domain,
	].join("\n"),
}));

function lexicalRanking(query: string): RegisteredCapability[] {
	return lexicalIndex
		.map(({ capability, body }) => ({
			capability,
			score: identityBodyScore(query, capability.name, body, true),
		}))
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score)
		.map(({ capability }) => capability);
}

function matchDetail(capability: RegisteredCapability) {
	return {
		name: capability.name,
		domain: capability.domain,
		description: capability.description,
		inputSchema: z.toJSONSchema(capability.inputSchema),
		callExample: callExample(capability),
	};
}

function isSearchOffline(env: Env): boolean {
	if (env.SEARCH_OFFLINE === "true") {
		return true;
	}
	return !env.AI || !env.VECTORIZE;
}

async function contentStamp(texts: string[]): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(texts)),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function ensureCapabilityIndex(env: Env): Promise<void> {
	if (!env.VECTORIZE) {
		throw new Error("Vectorize binding is unavailable");
	}
	const texts = capabilities.map(capabilityText);
	const stamp = await contentStamp(texts);
	if ((await env.OAUTH_KV.get(CONTENT_STAMP_KEY)) === stamp) {
		return;
	}

	const embeddings = await embedTexts(env, texts);
	await env.VECTORIZE.upsert(
		capabilities.map((capability, index) => ({
			id: `${VECTOR_ID_PREFIX}${capability.name}`,
			values: embeddings[index]!,
			namespace: CAPABILITY_NAMESPACE,
		})),
	);
	await env.OAUTH_KV.put(CONTENT_STAMP_KEY, stamp);
}

async function vectorRanking(
	query: string,
	env: Env,
): Promise<RegisteredCapability[]> {
	if (!env.VECTORIZE || capabilities.length === 0) {
		return [];
	}

	await ensureCapabilityIndex(env);
	const [queryEmbedding] = await embedTexts(env, [query]);
	const result = await env.VECTORIZE.query(queryEmbedding!, {
		topK: capabilities.length,
		namespace: CAPABILITY_NAMESPACE,
	});
	const capabilitiesByName = new Map(
		capabilities.map((capability) => [capability.name, capability]),
	);

	return result.matches.flatMap(({ id }) => {
		if (!id.startsWith(VECTOR_ID_PREFIX)) {
			return [];
		}
		const capability = capabilitiesByName.get(id.slice(VECTOR_ID_PREFIX.length));
		return capability ? [capability] : [];
	});
}

function fuseRankings(
	lexical: RegisteredCapability[],
	vector: RegisteredCapability[],
): RegisteredCapability[] {
	const scores = new Map<
		string,
		{ capability: RegisteredCapability; score: number; order: number }
	>();
	let order = 0;

	for (const ranking of [lexical, vector]) {
		ranking.forEach((capability, index) => {
			const existing = scores.get(capability.name);
			if (existing) {
				existing.score += 1 / (RRF_CONSTANT + index + 1);
				return;
			}
			scores.set(capability.name, {
				capability,
				score: 1 / (RRF_CONSTANT + index + 1),
				order,
			});
			order += 1;
		});
	}

	// A capability has no vector for a short time after it is added or
	// changed, because Vectorize applies an upsert asynchronously. Counting
	// its lexical rank for both signals keeps it on the same scale as the
	// rest; with one term it sinks below every capability that has two.
	const withVector = new Set(vector.map(({ name }) => name));
	lexical.forEach((capability, index) => {
		if (!withVector.has(capability.name)) {
			scores.get(capability.name)!.score += 1 / (RRF_CONSTANT + index + 1);
		}
	});

	return [...scores.values()]
		.sort((left, right) => right.score - left.score || left.order - right.order)
		.map(({ capability }) => capability);
}

export async function searchCapabilities(query: string, env: Env) {
	const normalizedQuery = query.trim().replace(/\s+/g, " ").toLowerCase();
	if (!normalizedQuery || OVERVIEW_QUERIES.has(normalizedQuery)) {
		return {
			domains: Object.entries(capabilityRegistry).map(
				([domain, { description, capabilities }]) => ({
					domain,
					description,
					capabilities: capabilities.map(({ name }) => name),
				}),
			),
		};
	}

	const requestedName = normalizedQuery.startsWith("name:")
		? normalizedQuery.slice("name:".length).trim()
		: normalizedQuery;
	const exact = capabilities.find(
		(capability) => capability.name.toLowerCase() === requestedName,
	);
	if (exact) {
		return {
			capability: {
				...matchDetail(exact),
				keywords: exact.keywords ?? [],
			},
		};
	}

	const lexical = lexicalRanking(normalizedQuery);
	if (isSearchOffline(env)) {
		return {
			matches: lexical.slice(0, MAX_MATCHES).map(matchDetail),
			offline: true as const,
		};
	}

	const vector = await vectorRanking(normalizedQuery, env);
	return {
		matches: fuseRankings(lexical, vector)
			.slice(0, MAX_MATCHES)
			.map(matchDetail),
	};
}
