import { z } from "zod";
import type { Env } from "../env";
import type { Capability } from "./index";

const BACKEND_NOT_CONFIGURED = "The contacts backend is not configured.";

const accountSchema = z.object({ address: z.email() });
const resourceSchema = accountSchema.extend({ id: z.uuid() });
const findContactsSchema = accountSchema.extend({
	q: z.string().min(1).optional(),
	addressbook: z.uuid().optional(),
	categories: z.array(z.string().trim().min(1)).min(1).optional(),
});
const contactValueSchema = z.object({
	value: z.string().min(1),
	type: z.string().optional(),
	pref: z.boolean().optional(),
});
const contactNameSchema = z.object({
	family: z.string(),
	given: z.string(),
	additional: z.string().default(""),
	prefix: z.string().default(""),
	suffix: z.string().default(""),
});
const contactAddressSchema = z.object({
	street: z.string(),
	city: z.string(),
	region: z.string(),
	postal: z.string(),
	country: z.string(),
	type: z.string().optional(),
});
// Photos are deliberately excluded from contact writes.
const contactWriteSchema = accountSchema.extend({
	addressbook: z.uuid(),
	fn: z.string().min(1),
	n: contactNameSchema.optional(),
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
const contactUpdateBodySchema = z
	.object({
		fn: z.string().min(1).optional(),
		n: contactNameSchema.nullable().optional(),
		nickname: z.string().nullable().optional(),
		org: z.string().nullable().optional(),
		title: z.string().nullable().optional(),
		emails: z.array(contactValueSchema).nullable().optional(),
		tels: z.array(contactValueSchema).nullable().optional(),
		urls: z.array(contactValueSchema).nullable().optional(),
		adrs: z.array(contactAddressSchema).nullable().optional(),
		bday: z.string().nullable().optional(),
		anniversary: z.string().nullable().optional(),
		note: z.string().nullable().optional(),
		categories: z.array(z.string()).nullable().optional(),
	})
	.refine(
		(input) =>
			input.fn !== undefined ||
			input.n !== undefined ||
			input.nickname !== undefined ||
			input.org !== undefined ||
			input.title !== undefined ||
			input.emails !== undefined ||
			input.tels !== undefined ||
			input.urls !== undefined ||
			input.adrs !== undefined ||
			input.bday !== undefined ||
			input.anniversary !== undefined ||
			input.note !== undefined ||
			input.categories !== undefined,
		{ message: "At least one contact field is required" },
	);
const updateContactSchema = contactUpdateBodySchema.safeExtend({
	...resourceSchema.shape,
	etag: z.string().min(1).optional(),
});
const deleteContactSchema = resourceSchema;
const listContactGroupsSchema = accountSchema.extend({
	addressbook: z.uuid().optional(),
});
const createContactGroupSchema = accountSchema.extend({
	addressbook: z.uuid(),
	name: z.string().min(1),
	members: z.array(z.uuid()).optional(),
});
const updateContactGroupSchema = resourceSchema
	.extend({
		etag: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		addMembers: z.array(z.uuid()).optional(),
		removeMembers: z.array(z.uuid()).optional(),
		removeMemberUids: z.array(z.string().min(1)).optional(),
	})
	.refine(
		(input) =>
			input.name !== undefined ||
			input.addMembers !== undefined ||
			input.removeMembers !== undefined ||
			input.removeMemberUids !== undefined,
		{ message: "At least one group change is required" },
	);

type ContactWrite = z.infer<typeof contactWriteSchema>;
type ContactUpdate = z.infer<typeof updateContactSchema>;

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function compactCard(contact: {
	id: string;
	fn: string | null;
	emails: Array<{ value: string }>;
}) {
	return {
		id: contact.id,
		fn: contact.fn,
		emails: contact.emails.map((entry) => entry.value),
	};
}

function mergeContactField<T>(
	patch: T | null | undefined,
	current: T | null,
): T | undefined {
	return (patch === undefined ? current : patch) ?? undefined;
}

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	) as T;
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
		name: "contact_addressbooks",
		description:
			"Find which address books are available in an email account and get their UUIDs and display names",
		inputSchema: accountSchema,
		keywords: [
			"list address books",
			"list my address books",
			"available address books",
			"choose an address book",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.listAddressBooks(
				input as z.infer<typeof accountSchema>,
			);
		},
	},
	{
		name: "contact_find",
		description:
			"Look up a person by name or email substring, or everyone with given categories, to get their email address or phone number; contact groups are not included, and contact_addressbooks lists available address book UUIDs",
		inputSchema: findContactsSchema,
		keywords: [
			"find a contact",
			"look up a person",
			"what is their email address",
			"phone number for",
			"address book",
			"contacts with a category",
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
			"Save a new person to the address book. Likely duplicates are refused unless force: true marks this as a genuinely different person; contact_addressbooks lists available address book UUIDs",
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
							"A likely matching contact exists. Use contact_update on the existing card, or pass force: true for a genuinely different person.",
					};
				}
			}
			const created = await env.BUREAU.createContact(write);
			return { created: true, contact: compactCard(created) };
		},
	},
	{
		name: "contact_update",
		description:
			"Update someone's contact details, such as their name, job title, phone numbers, email addresses, organisation, address, dates, notes, or categories; any field except fn can be null to clear it, and an ETag from contact_read can make the update safe",
		inputSchema: updateContactSchema,
		keywords: [
			"update contact",
			"edit contact",
			"update someone's details",
			"change job title",
			"change phone number",
			"change email address",
		],
		handler: async (rawInput, { env }) => {
			if (!env.BUREAU) return unavailable();
			const input = rawInput as ContactUpdate;
			const current = await env.BUREAU.getContact({
				address: input.address,
				id: input.id,
			});
			const fn = input.fn ?? current.fn;
			if (fn === null) {
				throw new Error(
					"This contact has no formatted name; provide fn to update it",
				);
			}

			return env.BUREAU.updateContact(
				omitUndefined({
					address: input.address,
					id: input.id,
					etag: input.etag ?? current.etag,
					addressbook: current.addressbook,
					fn,
					n: mergeContactField(input.n, current.n),
					nickname: mergeContactField(input.nickname, current.nickname),
					org: mergeContactField(input.org, current.org),
					title: mergeContactField(input.title, current.title),
					emails: mergeContactField(input.emails, current.emails),
					tels: mergeContactField(input.tels, current.tels),
					urls: mergeContactField(input.urls, current.urls),
					adrs: mergeContactField(input.adrs, current.adrs),
					bday: mergeContactField(input.bday, current.bday),
					anniversary: mergeContactField(
						input.anniversary,
						current.anniversary,
					),
					note: mergeContactField(input.note, current.note),
					categories: mergeContactField(
						input.categories,
						current.categories,
					),
				}),
			);
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
	{
		name: "contact_group_list",
		description:
			"List my contact groups, such as family or a team, with their member counts",
		inputSchema: listContactGroupsSchema,
		keywords: [
			"list contact groups",
			"which contact groups exist",
			"my contact groups",
			"distribution lists",
			"groups of people",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.listContactGroups(
				input as z.infer<typeof listContactGroupsSchema>,
			);
		},
	},
	{
		name: "contact_group_read",
		description:
			"See who is in a contact group; members that no longer exist are listed as unresolved UIDs",
		inputSchema: resourceSchema,
		keywords: [
			"who is in this group",
			"members of a contact group",
			"list group members",
			"open contact group",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.getContactGroup(
				input as z.infer<typeof resourceSchema>,
			);
		},
	},
	{
		name: "contact_group_create",
		description:
			"Create a contact group, such as family or a project team, optionally with contacts from the same address book as members",
		inputSchema: createContactGroupSchema,
		keywords: [
			"create contact group",
			"new group of contacts",
			"make a distribution list",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.createContactGroup(
				input as z.infer<typeof createContactGroupSchema>,
			);
		},
	},
	{
		name: "contact_group_update",
		description:
			"Rename a contact group or add and remove its members; removeMemberUids drops members that no longer exist, and an ETag from contact_group_read can make the update safe",
		inputSchema: updateContactGroupSchema,
		keywords: [
			"add someone to a group",
			"remove someone from a group",
			"rename contact group",
			"change group members",
		],
		handler: async (rawInput, { env }) => {
			if (!env.BUREAU) return unavailable();
			const input = rawInput as z.infer<typeof updateContactGroupSchema>;
			const etag =
				input.etag ??
				(
					await env.BUREAU.getContactGroup({
						address: input.address,
						id: input.id,
					})
				).etag;
			return env.BUREAU.updateContactGroup({ ...input, etag });
		},
	},
	{
		name: "contact_group_delete",
		description:
			"Delete a contact group without deleting the people in it",
		inputSchema: deleteContactSchema,
		keywords: [
			"delete contact group",
			"remove a group",
			"drop distribution list",
		],
		handler: async (rawInput, { env }) => {
			if (!env.BUREAU) return unavailable();
			const removed = await env.BUREAU.removeContactGroup(
				rawInput as z.infer<typeof deleteContactSchema>,
			);
			return { deleted: true, id: removed.id };
		},
	},
];
