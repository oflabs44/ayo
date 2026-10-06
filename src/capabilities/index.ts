import { z } from "zod";
import type { Env, OwnerProps } from "../env";
import { ai } from "./ai";
import { calendar } from "./calendar";
import { contacts } from "./contacts";
import { documents } from "./documents";
import { email } from "./email";
import { github } from "./github";
import { jobs } from "./jobs";
import { ledger } from "./ledger";
import { memory } from "./memory";
import { meta } from "./meta";
import { migadu } from "./migadu";
import { notebook } from "./notebook";
import { ocr } from "./ocr";
import { tasks } from "./tasks";

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
		description:
			"List accounts, manage folders and tags, and search, read, draft, send, move, trash, and flag email",
		capabilities: email,
	},
	calendar: {
		description: "List calendars and read, create, update, or delete events",
		capabilities: calendar,
	},
	tasks: {
		description: "List, read, create, update, and delete tasks",
		capabilities: tasks,
	},
	contacts: {
		description:
			"List address books; look up, save, update, and remove contacts; and manage contact groups",
		capabilities: contacts,
	},
	// Declared after email: search breaks score ties by declaration order, and
	// documents' folder/tag vocabulary overlaps email's, so this preserves
	// email's existing tie-breaks instead of outranking them.
	documents: {
		description:
			"Search, read, update, move, trash, restore, and reprocess documents; manage folders and tags; upload and download files",
		capabilities: documents,
	},
	ocr: {
		description:
			"Read the text out of a scanned PDF, photo, or screenshot without archiving it",
		capabilities: ocr,
	},
	jobs: {
		description: "Schedule, inspect, run, update, and remove unattended scripts",
		capabilities: jobs,
	},
	github: {
		description: "File, list, read, and comment on Ayo and Bureau GitHub issues",
		capabilities: github,
	},
	migadu: {
		description:
			"Administer Migadu email hosting: onboard custom domains and create addresses and aliases",
		capabilities: migadu,
	},
	ledger: {
		description:
			"Keep the personal books in EUR: record spending and income, check balances, and report net worth",
		capabilities: ledger,
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
