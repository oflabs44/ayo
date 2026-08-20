import { z } from "zod";
import type { Env, OwnerProps } from "../env";
import { meta } from "./meta";
import { notebook } from "./notebook";

export type CapabilityContext = {
	env: Env;
	props: OwnerProps;
};

export type Capability = {
	name: string;
	description: string;
	inputSchema: z.ZodType;
	keywords?: string[];
	handler: (input: unknown, ctx: CapabilityContext) => unknown;
};

export type RegisteredCapability = Capability & {
	domain: string;
};

export const capabilityRegistry = {
	meta: {
		description: "Capabilities for introspection and discovery",
		capabilities: meta,
	},
	notebook: {
		description: "Write, read, list, and delete private notebook pages",
		capabilities: notebook,
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
