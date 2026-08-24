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
		handler: (_input, { props }) => props,
	},
	{
		name: "capabilities_list",
		description: "List all capabilities available to the caller",
		inputSchema: z.object({}),
		keywords: ["capabilities", "discovery", "registry", "tools"],
		handler: (_input, _ctx) =>
			capabilities.map(({ name, description }) => ({ name, description })),
	},
	{
		name: "accounts_list",
		description:
			"Tell which mail and calendar accounts are configured, without credentials",
		inputSchema: z.object({}),
		keywords: [
			"email accounts",
			"list mail accounts",
			"calendar accounts",
			"which inbox",
			"available addresses",
		],
		handler: async (_input, { env }) => {
			if (!env.BUREAU) {
				return { error: "The accounts backend is not configured." };
			}
			return env.BUREAU.listAccounts({});
		},
	},
];
