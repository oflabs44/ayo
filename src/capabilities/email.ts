import { z } from "zod";
import type { ComposedMail, MailSendResult } from "../env";
import type { Capability } from "./index";

const DRAFT_TTL_SECONDS = 86_400;
const BACKEND_NOT_CONFIGURED = "The email backend is not configured.";
// The reader clamps a larger limit to this silently.
const MAX_LIMIT = 200;
const STALE_READ_NOTE =
	"a read right after this can show the old state for a few seconds";

const accountSchema = z.object({ address: z.email() });
const recipientSchema = z.object({
	address: z.email(),
	name: z.string().min(1).optional(),
});
const tagNameSchema = z
	.string()
	.regex(/^[a-z0-9-]{1,40}$/, "A tag is 1 to 40 characters of a-z, 0-9 and -");
const dateSchema = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const filterFields = {
	folder: z.string().min(1).optional(),
	tags: z.array(tagNameSchema).min(1).optional(),
	unread: z.boolean().optional(),
	flagged: z.boolean().optional(),
	limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
};
// Strict: the reader ignores an option it does not know, so a misspelled
// filter would return unfiltered mail instead of an error.
const searchInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("threads"),
		address: z.email(),
		...filterFields,
		before: z
			.strictObject({
				lastDate: z.string().nullable(),
				id: z.string().min(1),
			})
			.optional(),
	}),
	z
		.strictObject({
			kind: z.literal("messages"),
			address: z.email().optional(),
			query: z.string().trim().min(1).optional(),
			...filterFields,
			from: z.string().min(1).optional(),
			after: dateSchema.optional(),
			before: dateSchema.optional(),
			hasAttachments: z.boolean().optional(),
			cursor: z
				.strictObject({
					date: z.string().nullable(),
					id: z.string().min(1),
				})
				.optional(),
		})
		.refine((input) => input.query !== undefined || input.address !== undefined, {
			message: "address is required when there is no query",
			path: ["address"],
		})
		.refine((input) => input.query === undefined || input.cursor === undefined, {
			message: "cursor pages a list; a query search has no next page",
			path: ["cursor"],
		}),
]);
const readInputSchema = accountSchema.extend({
	kind: z.enum(["thread", "message"]),
	id: z.string().min(1),
});
const attachmentReferenceSchema = z.strictObject({
	messageId: z.string().min(1),
	index: z.number().int().min(0),
	filename: z.string().min(1).optional(),
});
const draftInputSchema = z
	.strictObject({
		address: z.email(),
		to: z.array(recipientSchema).min(1).optional(),
		cc: z.array(recipientSchema).optional(),
		bcc: z.array(recipientSchema).optional(),
		subject: z.string(),
		body: z.string(),
		html: z.string().optional(),
		attachments: z.array(attachmentReferenceSchema).optional(),
		reference: z
			.strictObject({
				id: z.string().min(1),
				action: z.enum(["reply", "replyAll", "forward"]),
			})
			.optional(),
	})
	.refine(
		(input) =>
			input.to !== undefined ||
			input.reference?.action === "reply" ||
			input.reference?.action === "replyAll",
		{ message: "to is required unless this is a reply", path: ["to"] },
	);
type StoredDraft = z.infer<typeof draftInputSchema> & {
	to: z.infer<typeof recipientSchema>[];
};
const sendInputSchema = z.object({ draftId: z.string().min(1) });
// Strict: a misspelled `folder` would be dropped and widen the action to
// every copy of the message.
const messagesSchema = z.strictObject({
	address: z.email(),
	ids: z.array(z.string().min(1)).min(1),
});
// \Deleted would let another client's EXPUNGE remove the mail for good.
const flagSchema = z.enum(["\\Seen", "\\Flagged"]);
const trashInputSchema = messagesSchema.extend({
	folder: z.string().min(1).optional(),
});
const moveInputSchema = trashInputSchema.extend({ to: z.string().min(1) });
const tagInputSchema = messagesSchema.extend({ tag: tagNameSchema });
const flagInputSchema = messagesSchema
	.extend({
		add: z.array(flagSchema).optional(),
		remove: z.array(flagSchema).optional(),
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

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function draftKey(draftId: string): string {
	return `draft:${draftId}`;
}

// The reader gives `name: null` for an address with no display name.
function toRecipient({ address, name }: { address: string; name: string | null }) {
	return name ? { address, name } : { address };
}

export const email: Capability[] = [
	{
		name: "email_accounts",
		description:
			"Tell which email accounts are configured: each mailbox address with its label and sender name, without credentials or server details. Every other email call takes one of these addresses",
		inputSchema: z.object({}),
		keywords: [
			"email accounts",
			"list mail accounts",
			"which inbox",
			"my email addresses",
			"send from which address",
		],
		handler: async (_input, { env }) => {
			if (!env.MAIL_READER) return unavailable();
			const accounts = await env.MAIL_READER.listAccounts();
			return accounts.map(({ address, label, senderName }) => ({
				address,
				label,
				senderName,
			}));
		},
	},
	{
		name: "email_mailboxes",
		description:
			"List the mail folders in an account: each mailbox's path, message and unread counts, hierarchy delimiter, and special-use role - \\Sent, \\Drafts, \\Archive, \\Junk or \\Trash, or null. The inbox has no role: it is the mailbox at path INBOX. Every listed path holds mail and is valid for email_move and email_search. The delimiter and role are null for a few minutes after a folder first appears",
		inputSchema: accountSchema,
		keywords: [
			"list mail folders",
			"mailbox names",
			"imap folders",
			"folder paths for filing mail",
			"how many unread in each folder",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_READER) return unavailable();
			const { address } = input as z.infer<typeof accountSchema>;
			return env.MAIL_READER.listFolders(address);
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
			if (!env.MAIL_WRITER) return unavailable();
			const { address, path } = input as z.infer<typeof mailboxPathSchema>;
			const created = await env.MAIL_WRITER.createFolder(address, path);
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
			if (!env.MAIL_WRITER) return unavailable();
			const { address, path, to } = input as z.infer<
				typeof mailboxRenameSchema
			>;
			const renamed = await env.MAIL_WRITER.renameFolder(address, path, to);
			return { renamed: true, folder: renamed };
		},
	},
	{
		name: "email_mailbox_delete",
		description:
			"Delete an empty IMAP mailbox; INBOX, special-use, non-empty, and parent mailboxes are refused with an error that names the reason",
		inputSchema: mailboxPathSchema,
		keywords: [
			"delete an empty folder",
			"remove empty mailbox",
			"delete mailbox",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_WRITER) return unavailable();
			const { address, path } = input as z.infer<typeof mailboxPathSchema>;
			await env.MAIL_WRITER.deleteFolder(address, path);
			return { deleted: true, path };
		},
	},
	{
		name: "email_tags",
		description:
			"List the mail tags in use in an account, each with the count of messages that carry it. A tag is a plain lowercase name; the classifier sets some itself (attention, noise, needs-reply, urgent and others) up to five minutes after a mail arrives",
		inputSchema: accountSchema,
		keywords: [
			"list email tags",
			"which mail tags exist",
			"mail labels",
			"how many emails need a reply",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_READER) return unavailable();
			const { address } = input as z.infer<typeof accountSchema>;
			return env.MAIL_READER.listTags(address);
		},
	},
	{
		name: "email_tag",
		description:
			"Put a tag on one or more email messages, for example to label them or to correct the classifier; a tag is 1 to 40 characters of a-z, 0-9 and -, and a new name needs no setup. The change is immediate. Returns the succeeded and the failed message ids",
		inputSchema: tagInputSchema,
		keywords: [
			"tag this email",
			"label these messages",
			"apply a label to this message",
			"add a mail tag",
			"mark this mail as needing attention",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_WRITER) return unavailable();
			const { address, ids, tag } = input as z.infer<typeof tagInputSchema>;
			return env.MAIL_WRITER.tag(address, ids, tag);
		},
	},
	{
		name: "email_untag",
		description:
			"Take a tag off one or more email messages; the classifier does not put it back. The change is immediate. Returns the succeeded and the failed message ids",
		inputSchema: tagInputSchema,
		keywords: [
			"untag this email",
			"remove a label from this message",
			"take the tag off",
			"clear mail tag",
			"this mail is not urgent",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_WRITER) return unavailable();
			const { address, ids, tag } = input as z.infer<typeof tagInputSchema>;
			return env.MAIL_WRITER.untag(address, ids, tag);
		},
	},
	{
		name: "email_search",
		description:
			'Find email. kind "threads" lists the conversations of an account, newest first. kind "messages" with a query is a full-text search of subject, sender, recipients and body, across every account when address is omitted; without a query it lists messages newest first and needs an address. Both filter by folder, tags, unread and flagged (flagged is starred); messages also filter by from, after, before and hasAttachments. To page a list, pass the last row back as before { lastDate, id } for threads or cursor { date, id } for messages. email_accounts gives the addresses, email_mailboxes the folder paths and email_tags the tags',
		inputSchema: searchInputSchema,
		keywords: [
			"search email",
			"find mail",
			"list inbox threads",
			"starred email",
			"show unread mail",
			"messages with a tag",
			"recent messages",
			"mail from a sender",
			"emails with attachments",
		],
		handler: async (input, { env }) => {
			const reader = env.MAIL_READER;
			if (!reader) return unavailable();
			const search = input as z.infer<typeof searchInputSchema>;
			if (search.kind === "threads") {
				const { kind, address, ...options } = search;
				return reader.listThreads(address, options);
			}
			const { kind, address, query, cursor, ...filters } = search;
			if (query !== undefined) {
				return reader.search(address ?? null, { query, ...filters });
			}
			// The schema requires an address when there is no query.
			return reader.listMessages(address as string, {
				...filters,
				...(cursor ? { cursor } : {}),
			});
		},
	},
	{
		name: "email_read",
		description:
			"Read one email message or a thread with every message's full text, recipients, tags, folders and flags, and the list of attachments",
		inputSchema: readInputSchema,
		keywords: [
			"read email",
			"open mail thread",
			"show message body",
			"read conversation",
		],
		handler: async (input, { env }) => {
			const reader = env.MAIL_READER;
			if (!reader) return unavailable();
			const { kind, address, id } = input as z.infer<typeof readInputSchema>;
			if (kind === "message") {
				return (
					(await reader.getMessage(address, id)) ?? {
						error: `There is no message ${id} in ${address}.`,
					}
				);
			}

			const thread = await reader.getThread(address, id);
			if (!thread) return { error: `There is no thread ${id} in ${address}.` };
			const messages = await Promise.all(
				thread.map((message) => reader.getMessage(address, message.id)),
			);
			// A message removed between the two reads comes back null.
			const liveMessages = messages.filter((message) => message !== null);
			if (liveMessages.length === 0) {
				return { error: `There is no thread ${id} in ${address}.` };
			}
			return { id, messages: liveMessages };
		},
	},
	{
		name: "email_draft",
		description:
			"Compose an email as a draft for review without sending it; returns a draftId for email_send and a preview to show me. For a reply, give reference { id, action: reply or replyAll } and omit to: the recipients are filled in from that message. For a forward, give to; the original attachments come along unless attachments lists other ones. Attachments are references to an attachment of an existing message, { messageId, index }. Write any quoted text into body yourself",
		inputSchema: draftInputSchema,
		keywords: [
			"draft email",
			"compose a new email",
			"write mail",
			"prepare reply",
			"reply to all",
			"forward email",
			"write email without sending",
		],
		handler: async (input, { env }) => {
			const draft = { ...(input as z.infer<typeof draftInputSchema>) };
			const reference = draft.reference;
			if (reference && reference.action !== "forward" && !draft.to) {
				if (!env.MAIL_READER) return unavailable();
				const recipients = await env.MAIL_READER.getReplyRecipients(
					draft.address,
					reference.id,
					{ all: reference.action === "replyAll" },
				);
				draft.to = recipients.to.map(toRecipient);
				if (!draft.cc && recipients.cc.length > 0) {
					draft.cc = recipients.cc.map(toRecipient);
				}
				if (draft.to.length === 0) {
					return {
						error: `Message ${reference.id} gives no address to reply to; pass to.`,
					};
				}
			}
			if (reference?.action === "forward" && !draft.attachments) {
				if (!env.MAIL_READER) return unavailable();
				const original = await env.MAIL_READER.getMessage(
					draft.address,
					reference.id,
				);
				if (!original) {
					return {
						error: `There is no message ${reference.id} in ${draft.address}.`,
					};
				}
				if (original.attachments.length > 0) {
					// The writer refuses a reference to an unnamed attachment
					// unless the reference names it.
					draft.attachments = original.attachments.map(
						({ index, filename }) => ({
							messageId: reference.id,
							index,
							...(filename ? {} : { filename: `attachment-${index + 1}` }),
						}),
					);
				}
			}

			const draftId = crypto.randomUUID();
			await env.OAUTH_KV.put(draftKey(draftId), JSON.stringify(draft), {
				expirationTtl: DRAFT_TTL_SECONDS,
			});
			return { draftId, preview: draft };
		},
	},
	{
		name: "email_send",
		description:
			"Send a previously reviewed email draft. sent: true means it left; result lists any rejected recipients and follow-up errors. sent: false with status refused means nothing left and the draft is kept. status unknown means it possibly left: check the Sent folder and never send again without asking me",
		inputSchema: sendInputSchema,
		keywords: [
			"send email draft",
			"send reviewed mail",
			"approve and send email",
			"deliver draft",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_WRITER) return unavailable();
			const { draftId } = input as z.infer<typeof sendInputSchema>;
			const key = draftKey(draftId);
			const storedDraft = await env.OAUTH_KV.get(key);
			if (!storedDraft) {
				return {
					sent: false,
					error: `Email draft ${draftId} is unknown or expired.`,
				};
			}

			const draft = JSON.parse(storedDraft) as StoredDraft;
			// The writer throws on a key it does not know, so name each field.
			const mail: ComposedMail = {
				to: draft.to,
				cc: draft.cc,
				bcc: draft.bcc,
				subject: draft.subject,
				text: draft.body,
				html: draft.html,
				attachments: draft.attachments,
			};
			const reference = draft.reference;
			// The draft is consumed before the send: whatever happens next (an
			// unconfirmed send, a broken RPC call, the execute time budget), the
			// same draftId cannot send a second time.
			await env.OAUTH_KV.delete(key);
			const possiblySent = (reason: string) => ({
				sent: false,
				status: "unknown",
				message: `The send was not confirmed, so the mail may have left (${reason}). Check the Sent folder with email_search. Do not send it again without asking the user; the draft was removed and must be composed again.`,
			});
			let result: MailSendResult;
			try {
				result =
					reference && reference.action !== "forward"
						? await env.MAIL_WRITER.send(draft.address, mail, {
								answers: reference.id,
							})
						: await env.MAIL_WRITER.send(draft.address, mail);
			} catch (error) {
				// The writer itself throws only before it sends, but the call can
				// also break after the driver started, and the two look the same.
				console.error("ayo email send failed", error);
				return possiblySent(
					error instanceof Error ? error.message : String(error),
				);
			}
			if (result.status === "unknown") return possiblySent(result.message);
			if (result.status === "refused") {
				// Nothing was sent, so the draft goes back for another try.
				await env.OAUTH_KV.put(key, storedDraft, {
					expirationTtl: DRAFT_TTL_SECONDS,
				});
				return { sent: false, status: result.status, message: result.message };
			}
			return { sent: true, result };
		},
	},
	{
		name: "email_move",
		description: `Move one or more email messages to another mailbox, for example to archive them; email_mailboxes lists the folder paths this accepts. Every copy of a message moves unless folder names the one to take it from. Returns the succeeded and the failed message ids; ${STALE_READ_NOTE}`,
		inputSchema: moveInputSchema,
		keywords: [
			"move email",
			"file message",
			"move mail to folder",
			"archive message",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_WRITER) return unavailable();
			const { address, ids, to, folder } = input as z.infer<
				typeof moveInputSchema
			>;
			return folder
				? env.MAIL_WRITER.moveMessages(address, ids, to, { folder })
				: env.MAIL_WRITER.moveMessages(address, ids, to);
		},
	},
	{
		name: "email_trash",
		description: `Delete one or more email messages by moving them to the Trash folder, where they can still be recovered. Every copy of a message goes unless folder names the one to take it from, for example Junk. Returns the succeeded and the failed message ids; ${STALE_READ_NOTE}`,
		inputSchema: trashInputSchema,
		keywords: [
			"delete email",
			"trash this message",
			"bin this mail",
			"throw away these emails",
			"move to trash",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_WRITER) return unavailable();
			const { address, ids, folder } = input as z.infer<
				typeof trashInputSchema
			>;
			return folder
				? env.MAIL_WRITER.trashMessages(address, ids, { folder })
				: env.MAIL_WRITER.trashMessages(address, ids);
		},
	},
	{
		name: "email_flag",
		description: `Mark one or more email messages read or unread, or star and unstar them, by adding or removing the IMAP flags \\Seen (read) and \\Flagged (star). Tags are not flags: email_tag sets those. Returns the succeeded and the failed message ids; ${STALE_READ_NOTE}`,
		inputSchema: flagInputSchema,
		keywords: [
			"flag email",
			"star message",
			"mark as read",
			"mark unread",
			"remove flag",
			"unstar",
		],
		handler: async (input, { env }) => {
			if (!env.MAIL_WRITER) return unavailable();
			const { address, ids, add, remove } = input as z.infer<
				typeof flagInputSchema
			>;
			return env.MAIL_WRITER.setFlags(address, ids, {
				...(add ? { add } : {}),
				...(remove ? { remove } : {}),
			});
		},
	},
];
