import { z } from "zod";
import {
	capabilities,
	capabilityRegistry,
	type RegisteredCapability,
} from "./capabilities/index";

function callExample(capability: RegisteredCapability): string {
	return `await ayo.${capability.name}({})`;
}

function lexicalScore(
	capability: RegisteredCapability,
	query: string,
): number {
	const name = capability.name.toLowerCase();
	if (name === query) {
		return 4;
	}
	if (name.includes(query)) {
		return 3;
	}
	if (
		capability.keywords?.some((keyword) =>
			keyword.toLowerCase().includes(query),
		)
	) {
		return 2;
	}
	if (capability.description.toLowerCase().includes(query)) {
		return 1;
	}
	return 0;
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

export function searchCapabilities(query: string) {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
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

	const matches = capabilities
		.map((capability) => ({
			capability,
			score: lexicalScore(capability, normalizedQuery),
		}))
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score)
		.map(({ capability }) => matchDetail(capability));

	return { matches };
}
