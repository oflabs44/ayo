import { z } from "zod";
import { meta } from "./meta";

export type Capability = {
	name: string;
	description: string;
	inputSchema: z.ZodType;
	handler: (input: unknown, props: unknown) => unknown;
};

export type RegisteredCapability = Capability & {
	domain: string;
};

const capabilitiesByDomain = { meta } satisfies Record<string, Capability[]>;

export const capabilities: RegisteredCapability[] = Object.entries(
	capabilitiesByDomain,
).flatMap(([domain, entries]) =>
	entries.map((entry) => ({ ...entry, domain })),
);
