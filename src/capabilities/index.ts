import { z } from "zod";
import { meta } from "./meta";

export type Capability = {
	name: string;
	description: string;
	inputSchema: z.ZodType;
	keywords?: string[];
	handler: (input: unknown, props: unknown) => unknown;
};

export type RegisteredCapability = Capability & {
	domain: string;
};

export const capabilityRegistry = {
	meta: {
		description: "Capabilities for introspection and discovery",
		capabilities: meta,
	},
} satisfies Record<
	string,
	{ description: string; capabilities: Capability[] }
>;

export const capabilities: RegisteredCapability[] = Object.entries(
	capabilityRegistry,
).flatMap(([domain, group]) =>
	group.capabilities.map((entry) => ({ ...entry, domain })),
);
