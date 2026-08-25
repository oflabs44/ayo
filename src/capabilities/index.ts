import { z } from "zod";
import type { Env, OwnerProps } from "../env";
import { ai } from "./ai";
import { calendar } from "./calendar";
import { email } from "./email";
import { memory } from "./memory";
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
	memory: {
		description: "Remember, recall, and forget facts about the owner",
		capabilities: memory,
	},
	email: {
		description: "Search, read, draft, send, move, and flag email",
		capabilities: email,
	},
	calendar: {
		description: "List calendars and read, create, update, or delete events",
		capabilities: calendar,
	},
	ai: {
		description: "Run a model to judge, classify, or summarize something",
		capabilities: ai,
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
