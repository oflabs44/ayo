import { z } from "zod";
import { capabilities, type Capability } from "./index";

export const meta: Capability[] = [
	{
		name: "whoami",
		description: "Return the OAuth properties of the current caller",
		inputSchema: z.object({}),
		keywords: [
			"identity",
			"profile",
			"oauth",
			"caller",
			"who am i",
			"account",
			"signed in",
		],
		handler: (_input, props) => props,
	},
	{
		name: "capabilities_list",
		description: "List all capabilities available to the caller",
		inputSchema: z.object({}),
		keywords: ["capabilities", "discovery", "registry", "tools"],
		handler: () =>
			capabilities.map(({ name, description }) => ({ name, description })),
	},
];
