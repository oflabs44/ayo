import { z } from "zod";
import {
	capabilities,
	capabilityRegistry,
	type RegisteredCapability,
} from "./capabilities/index";
import type { Env } from "./env";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
const CAPABILITY_NAMESPACE = "capabilities";
const CONTENT_STAMP_KEY = "search:capabilities:content-stamp";
const VECTOR_ID_PREFIX = "capability:";
const RRF_CONSTANT = 60;
const OVERVIEW_QUERIES = new Set(["what can you do"]);

function callExample(capability: RegisteredCapability): string {
	return `await ayo.${capability.name}({})`;
}

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

function capabilityText(capability: RegisteredCapability): string {
	return [
		capability.name,
		capability.domain,
		capability.description,
		...(capability.keywords ?? []),
	].join("\n");
}

function lexicalScore(
	capability: RegisteredCapability,
	query: string,
): number {
	const queryTokens = tokenize(query);
	const body = [
		capability.description,
		...(capability.keywords ?? []),
		capability.domain,
	].join("\n");

	return (
		0.7 * tokenOverlap(queryTokens, body) +
		0.3 * tokenOverlap(queryTokens, capability.name)
	);
}

function lexicalRanking(query: string): RegisteredCapability[] {
	return capabilities
		.map((capability) => ({
			capability,
			score: lexicalScore(capability, query),
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

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
	if (!env.AI) {
		throw new Error("Workers AI binding is unavailable");
	}
	const response = await env.AI.run(EMBEDDING_MODEL, { text: texts });
	if (response.data.length !== texts.length) {
		throw new Error(
			`Embedding returned ${response.data.length} vectors for ${texts.length} texts`,
		);
	}
	return response.data;
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
			matches: lexical.map(matchDetail),
			offline: true as const,
		};
	}

	const vector = await vectorRanking(normalizedQuery, env);
	return { matches: fuseRankings(lexical, vector).map(matchDetail) };
}
