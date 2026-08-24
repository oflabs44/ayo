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
		...paginationFields,
		beforeId: z.string().min(1).optional(),
	}),
	accountSchema.extend({
		kind: z.literal("messages"),
		folder: z.string().min(1).optional(),
		threadId: z.string().min(1).optional(),
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

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

function draftKey(draftId: string): string {
	return `draft:${draftId}`;
}

export const email: Capability[] = [
	{
		name: "email_search",
		description:
			"Find email threads or messages in an account; use accounts_list to find valid addresses",
		inputSchema: searchInputSchema,
		keywords: [
			"search email",
			"find mail",
			"list inbox threads",
			"starred email",
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
		description: "Move an email message to another mailbox",
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
		description: "Add or remove flags such as read or starred on an email message",
		inputSchema: flagInputSchema,
		keywords: [
			"flag email",
			"star message",
			"mark as read",
			"mark unread",
			"remove flag",
		],
		handler: async (input, { env }) => {
			if (!env.BUREAU) return unavailable();
			return env.BUREAU.setMessageFlags(
				input as z.infer<typeof flagInputSchema>,
			);
		},
	},
];
