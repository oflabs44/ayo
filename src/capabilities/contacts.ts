import { z } from "zod";
import type { Env } from "../env";
import type { Capability } from "./index";

const BACKEND_NOT_CONFIGURED = "The contacts backend is not configured.";

const accountSchema = z.object({ address: z.email() });
const resourceSchema = accountSchema.extend({ id: z.uuid() });
const findContactsSchema = accountSchema.extend({
	q: z.string().min(1).optional(),
	addressbook: z.uuid().optional(),
});
const contactValueSchema = z.object({
	value: z.string().min(1),
	type: z.string().optional(),
	pref: z.boolean().optional(),
});
const contactAddressSchema = z.object({
	street: z.string(),
	city: z.string(),
	region: z.string(),
	postal: z.string(),
	country: z.string(),
	type: z.string().optional(),
});
// Photos are deliberately excluded, and updates stay in Bureau's UI.
const contactWriteSchema = accountSchema.extend({
	addressbook: z.uuid(),
	fn: z.string().min(1),
	n: z
		.object({
			family: z.string(),
			given: z.string(),
			additional: z.string().default(""),
			prefix: z.string().default(""),
			suffix: z.string().default(""),
		})
		.optional(),
	nickname: z.string().optional(),
	org: z.string().optional(),
	title: z.string().optional(),
	emails: z.array(contactValueSchema).optional(),
	tels: z.array(contactValueSchema).optional(),
	urls: z.array(contactValueSchema).optional(),
	adrs: z.array(contactAddressSchema).optional(),
	bday: z.string().optional(),
	anniversary: z.string().optional(),
	note: z.string().optional(),
	categories: z.array(z.string()).optional(),
});
const createContactSchema = contactWriteSchema.extend({
	force: z.boolean().optional(),
});
const deleteContactSchema = resourceSchema;

type ContactWrite = z.infer<typeof contactWriteSchema>;

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function compactCard(contact: {
	id: string;
	fn: string | null;
	emails: Array<Record<string, unknown>>;
}) {
	return {
		id: contact.id,
		fn: contact.fn,
		emails: contact.emails.map((entry) => entry.value),
	};
}

async function findLikelyDuplicates(
	env: Env,
	write: ContactWrite,
): Promise<Array<ReturnType<typeof compactCard>>> {
	if (!env.BUREAU) return [];
	const emails = (write.emails ?? []).map((entry) =>
		entry.value.toLowerCase(),
	);
	const queries = [...emails, write.fn];
	const seen = new Map<string, ReturnType<typeof compactCard>>();
	for (const q of queries) {
		const matches = await env.BUREAU.listContacts({
			address: write.address,
			q,
		});
		for (const match of matches) {
			const matchEmails = match.emails.map((entry) =>
				String(entry.value).toLowerCase(),
			);
			const sameEmail = emails.some((email) => matchEmails.includes(email));
			const sameName =
				match.fn !== null &&
				match.fn.toLowerCase() === write.fn.toLowerCase();
			if (sameEmail || sameName) seen.set(match.id, compactCard(match));
		}
	}
	return [...seen.values()];
}

export const contacts: Capability[] = [
	{
		name: "contact_find",
		description:
			"Look up a person in the address book by name or email substring to get their email address or phone number",
		inputSchema: findContactsSchema,
		keywords: [
			"find a contact",
			"look up a person",
			"what is their email address",
			"phone number for",
			"address book",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.listContacts(
				input as z.infer<typeof findContactsSchema>,
			);
		},
	},
	{
		name: "contact_read",
		description: "Open one contact card with every stored detail",
		inputSchema: resourceSchema,
		keywords: [
			"contact details",
			"full contact card",
			"open contact",
			"contact birthday",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			// raw is the vCard source and can embed base64 PHOTO bytes; the
			// no-photos guardrail keeps it out of results.
			const { raw: _raw, ...card } = await env.BUREAU.getContact(
				input as z.infer<typeof resourceSchema>,
			);
			return card;
		},
	},
	{
		name: "contact_create",
		description:
			"Save a new person to the address book. Likely duplicates are refused unless force: true marks this as a genuinely different person",
		inputSchema: createContactSchema,
		keywords: [
			"add a contact",
			"save a new person",
			"new address book entry",
			"add to my contacts",
		],
		handler: async (rawInput, { env }) => {
			if (!env.BUREAU) return unavailable();
			const { force, ...write } = rawInput as z.infer<
				typeof createContactSchema
			>;
			if (!force) {
				const duplicates = await findLikelyDuplicates(env, write);
				if (duplicates.length > 0) {
					return {
						created: false,
						matches: duplicates,
						error:
							"A likely matching contact exists. Contacts are managed in Bureau - update the existing card there, or pass force: true for a genuinely different person.",
					};
				}
			}
			const created = await env.BUREAU.createContact(write);
			return { created: true, contact: compactCard(created) };
		},
	},
	{
		name: "contact_delete",
		description: "Remove a person from the address book",
		inputSchema: deleteContactSchema,
		keywords: [
			"delete a contact",
			"remove from my contacts",
			"drop this person from the address book",
		],
		handler: async (rawInput, { env }) => {
			if (!env.BUREAU) return unavailable();
			const input = rawInput as z.infer<typeof deleteContactSchema>;
			const card = await env.BUREAU.getContact(input);
			const removed = await env.BUREAU.removeContact({
				...input,
				etag: card.etag,
			});
			return { deleted: true, id: removed.id };
		},
	},
];
