import { z } from "zod";

export type Capability = {
	domain: string;
	name: string;
	description: string;
	inputSchema: z.ZodType;
	handler: (input: unknown, props: unknown) => unknown;
};

export const capabilities: Capability[] = [
	{
		domain: "meta",
		name: "whoami",
		description: "Return the OAuth properties of the current caller",
		inputSchema: z.object({}),
		handler: (_input, props) => props,
	},
	{
		domain: "meta",
		name: "capabilities_list",
		description: "List all registered capabilities",
		inputSchema: z.object({}),
		handler: () =>
			capabilities.map(({ name, description }) => ({ name, description })),
	},
];
