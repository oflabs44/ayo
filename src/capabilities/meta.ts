import { z } from "zod";
import { capabilities, type Capability } from "./index";

export const meta: Capability[] = [
	{
		name: "whoami",
		description: "Return the OAuth properties of the current caller",
		inputSchema: z.object({}),
		handler: (_input, props) => props,
	},
	{
		name: "capabilities_list",
		description: "List all registered capabilities",
		inputSchema: z.object({}),
		handler: () =>
			capabilities.map(({ name, description }) => ({ name, description })),
	},
];
