import { z } from "zod";
import type { Capability } from "./index";

const DRAFT_TTL_SECONDS = 86_400;
const BACKEND_NOT_CONFIGURED = "The email backend is not configured.";

const accountSchema = z.object({ address: z.email() });
const recipientSchema = z.object({
	address: z.email(),
	name: z.string().min(1).optional(),
});
const paginationFields = {
	limit: z.number().int().min(1).max(100).optional(),
	before: z.iso.datetime().optional(),
};
const searchInputSchema = z.discriminatedUnion("kind", [
	accountSchema.extend({
		kind: z.literal("threads"),
		folder: z.string().min(1).optional(),
		starred: z.boolean().optional(),
		tag: z.uuid().optional(),
		...paginationFields,
		beforeId: z.string().min(1).optional(),
	}),
	accountSchema.extend({
		kind: z.literal("messages"),
		folder: z.string().min(1).optional(),
		threadId: z.string().min(1).optional(),
		tag: z.uuid().optional(),
		...paginationFields,
	}),
]);
const readInputSchema = accountSchema.extend({
	kind: z.enum(["thread", "message"]),
	id: z.string().min(1),
});
const draftInputSchema = accountSchema.extend({
	to: z.array(recipientSchema).min(1),
	cc: z.array(recipientSchema).optional(),
	bcc: z.array(recipientSchema).optional(),
	subject: z.string(),
	body: z.string(),
	reference: z
		.object({
			id: z.string().min(1),
			action: z.enum(["reply", "replyAll", "forward"]),
		})
		.optional(),
});
const sendInputSchema = z.object({ draftId: z.string().min(1) });
const moveInputSchema = accountSchema.extend({
	id: z.string().min(1),
	to: z.string().min(1),
});
const flagInputSchema = accountSchema
	.extend({
		id: z.string().min(1),
		add: z.array(z.string().min(1)).optional(),
		remove: z.array(z.string().min(1)).optional(),
	})
	.refine(
		(input) => (input.add?.length ?? 0) + (input.remove?.length ?? 0) > 0,
		{ message: "At least one flag must be added or removed" },
	);

const mailboxNameSchema = z
	.string()
	.trim()
	.min(1)
	.regex(
		/^[^\u0000-\u001f\u007f]+$/,
		"Mailbox names cannot contain control characters",
	);
const mailboxPathSchema = accountSchema.extend({ path: mailboxNameSchema });
const mailboxRenameSchema = mailboxPathSchema.extend({ to: mailboxNameSchema });

const tagWriteSchema = z.object({
	name: z.string().min(1),
	color: z.string().min(1).optional(),
});
const tagUpdateSchema = z
	.object({
		id: z.uuid(),
		name: z.string().min(1).optional(),
		color: z.string().min(1).nullable().optional(),
	})
	.refine((input) => input.name !== undefined || input.color !== undefined, {
		message: "At least one tag field is required",
	});

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function draftKey(draftId: string): string {
	return `draft:${draftId}`;
}

export const email: Capability[] = [
	{
		name: "email_mailboxes",
		description:
			"List the mail folders in an account: each mailbox's path, display name, hierarchy delimiter, and special-use role - \\Sent, \\Drafts, \\Archive, \\Junk, \\Trash, \\All or \\Flagged, or null. The inbox has no role: it is the mailbox at path INBOX. email_move and email_search expect one of these paths, except one marked noselect - that is a naming node in the hierarchy and cannot hold mail",
		inputSchema: accountSchema,
		keywords: [
			"list mail folders",
			"mailbox names",
			"imap folders",
			"folder paths for filing mail",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.listMailboxes(input as z.infer<typeof accountSchema>);
		},
	},
	{
		name: "email_mailbox_create",
		description:
			"Create a new IMAP mail folder; nest it with the server delimiter shown by email_mailboxes",
		inputSchema: mailboxPathSchema,
		keywords: [
			"create a mail folder",
			"make a new mailbox",
			"add email folder",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			const created = await env.BUREAU.createMailbox(
				input as z.infer<typeof mailboxPathSchema>,
			);
			return { created: true, folder: created };
		},
	},
	{
		name: "email_mailbox_rename",
		description:
			"Rename an IMAP mail folder; its child folders move too, and INBOX cannot be renamed",
		inputSchema: mailboxRenameSchema,
		keywords: [
			"rename this folder",
			"change mailbox name",
			"rename mail folder",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			const renamed = await env.BUREAU.renameMailbox(
				input as z.infer<typeof mailboxRenameSchema>,
			);
			return { renamed: true, folder: renamed };
		},
	},
	{
		name: "email_mailbox_delete",
		description:
			"Delete an empty IMAP mailbox; INBOX, special-use, non-empty, and parent mailboxes are refused",
		inputSchema: mailboxPathSchema,
		keywords: [
			"delete an empty folder",
			"remove empty mailbox",
			"delete mailbox",
		],
		handler: async (rawInput, { env }) => {
			if (!env.BUREAU) return unavailable();
			const input = rawInput as z.infer<typeof mailboxPathSchema>;
			const mailboxes = await env.BUREAU.listMailboxes({
				address: input.address,
			});
			if (!mailboxes.some((entry) => entry.path === input.path)) {
				return {
					deleted: false,
					error: `No folder with path ${input.path} is listed for ${input.address}.`,
				};
			}
			const removed = await env.BUREAU.deleteMailbox(input);
			return { deleted: true, path: removed.path };
		},
	},
	{
		name: "email_tags",
		description:
			"List the mail tag registry: each tag's id, display name, color, and the IMAP keyword that email_flag applies or removes",
		inputSchema: z.object({}),
		keywords: [
			"list email tags",
			"which mail tags exist",
			"mail labels",
			"tag registry",
		],
		handler: async (_input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.listTags({});
		},
	},
	{
		name: "email_tag_create",
		description:
			"Create a new mail tag; Bureau derives its permanent IMAP keyword from the name and refuses reserved or clashing ones",
		inputSchema: tagWriteSchema,
		keywords: [
			"create a tag",
			"new mail label",
			"add an email tag",
			"make a tag for",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			const created = await env.BUREAU.createTag(
				input as z.infer<typeof tagWriteSchema>,
			);
			return { created: true, tag: created };
		},
	},
	{
		name: "email_tag_update",
		description:
			"Rename or recolour a mail tag; the IMAP keyword never changes, so existing markers stay valid",
		inputSchema: tagUpdateSchema,
		keywords: [
			"rename a tag",
			"change tag color",
			"edit mail label",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			const updated = await env.BUREAU.updateTag(
				input as z.infer<typeof tagUpdateSchema>,
			);
			return { updated: true, tag: updated };
		},
	},
	{
		name: "email_tag_delete",
		description:
			"Delete a mail tag from the registry; server-side markers stay in place, and recreating the same name restores the same keyword",
		inputSchema: z.object({ id: z.uuid() }),
		keywords: [
			"delete a tag",
			"remove mail label",
			"drop a mail tag",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			const removed = await env.BUREAU.deleteTag(input as { id: string });
			return { deleted: true, id: removed.id };
		},
	},
	{
		name: "email_search",
		description:
			"Find email threads or messages in an account; use accounts_list to find valid addresses, email_mailboxes for folder names, and email_tags to filter by tag",
		inputSchema: searchInputSchema,
		keywords: [
			"search email",
			"find mail",
			"list inbox threads",
			"starred email",
			"messages with a tag",
			"recent messages",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			const { kind, ...query } = input as z.infer<typeof searchInputSchema>;
			return kind === "threads"
				? env.BUREAU.listThreads(query)
				: env.BUREAU.listMessages(query);
		},
	},
	{
		name: "email_read",
		description: "Read one email message or a thread with every full message body",
		inputSchema: readInputSchema,
		keywords: [
			"read email",
			"open mail thread",
			"show message body",
			"read conversation",
		],
		handler: async (input, { env }) => {
			const bureau = env.BUREAU;
			if (!bureau) return unavailable();
			const { kind, address, id } = input as z.infer<typeof readInputSchema>;
			if (kind === "message") return bureau.getMessage({ address, id });

			const thread = await bureau.getThread({ address, id });
			const messages = await Promise.all(
				thread.messages.map((message) =>
					bureau.getMessage({ address, id: message.id }),
				),
			);
			return { ...thread, messages };
		},
	},
	{
		name: "email_draft",
		description: "Compose a new email as a draft for review without sending it",
		inputSchema: draftInputSchema,
		keywords: [
			"draft email",
			"compose a new email",
			"write mail",
			"prepare reply",
			"write email without sending",
		],
		handler: async (input, { env }) => {
			const draftId = crypto.randomUUID();
			const preview = input as z.infer<typeof draftInputSchema>;
			await env.OAUTH_KV.put(draftKey(draftId), JSON.stringify(preview), {
				expirationTtl: DRAFT_TTL_SECONDS,
			});
			return { draftId, preview };
		},
	},
	{
		name: "email_send",
		description: "Send a previously reviewed email draft",
		inputSchema: sendInputSchema,
		keywords: [
			"send email draft",
			"send reviewed mail",
			"approve and send email",
			"deliver draft",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			const { draftId } = input as z.infer<typeof sendInputSchema>;
			const key = draftKey(draftId);
			const storedDraft = await env.OAUTH_KV.get(key);
			if (!storedDraft) {
				return {
					sent: false,
					error: `Email draft ${draftId} is unknown or expired.`,
				};
			}

			const preview = draftInputSchema.parse(JSON.parse(storedDraft));
			const { body, ...message } = preview;
			const result = await env.BUREAU.send({ ...message, text: body });
			try {
				await env.OAUTH_KV.delete(key);
			} catch (error) {
				// The email already left; failing the call here would invite a
				// retry that sends a duplicate. The draft expires on its own.
				console.error("ayo email draft cleanup failed", error);
			}
			return { sent: true, result };
		},
	},
	{
		name: "email_move",
		description:
			"Move an email message to another mailbox; email_mailboxes lists the folder paths this accepts",
		inputSchema: moveInputSchema,
		keywords: [
			"move email",
			"file message",
			"move mail to folder",
			"archive message",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.moveMessage(input as z.infer<typeof moveInputSchema>);
		},
	},
	{
		name: "email_flag",
		description:
			"Add or remove flags on an email message: read or starred state, or a tag's keyword from email_tags to apply or clear that label",
		inputSchema: flagInputSchema,
		keywords: [
			"flag email",
			"star message",
			"mark as read",
			"mark unread",
			"remove flag",
			"apply a label to this message",
			"tag this email",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.setMessageFlags(
				input as z.infer<typeof flagInputSchema>,
			);
		},
	},
];
