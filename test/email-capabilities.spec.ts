import { describe, expect, it, vi } from "vitest";
import { email } from "../src/capabilities/email";
import type {
	Env,
	MailReaderBinding,
	MailWriterBinding,
	OwnerProps,
} from "../src/env";
import { buildDispatchTable } from "../src/execute";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};
const address = "oladayo@example.com";
const batchResult = { succeeded: ["message-1"], failed: [] };
const sentResult = {
	status: "sent" as const,
	rejected: [],
	sentCopy: { id: "driver-1", folder: "Sent" },
	followUpErrors: [],
};

function createHarness() {
	const drafts = new Map<string, string>();
	const reader = {
		listAccounts: vi.fn(async () => [
			{
				id: "account-1",
				address,
				label: "personal",
				senderName: "Oladayo",
				imap: { host: "imap.example.com", port: 993, user: address },
				smtp: { host: "smtp.example.com", port: 465, user: address },
				createdAt: "2026-09-01T00:00:00Z",
			},
		]),
		listFolders: vi.fn(async () => []),
		listThreads: vi.fn(async () => []),
		listMessages: vi.fn(async () => []),
		getThread: vi.fn(),
		getMessage: vi.fn(),
		listTags: vi.fn(async () => [{ tag: "needs-reply", count: 2 }]),
		getReplyRecipients: vi.fn(),
		search: vi.fn(async () => []),
	};
	const writer = {
		moveMessages: vi.fn(async () => batchResult),
		trashMessages: vi.fn(async () => batchResult),
		setFlags: vi.fn(async () => batchResult),
		tag: vi.fn(async () => batchResult),
		untag: vi.fn(async () => batchResult),
		createFolder: vi.fn(async (_address: string, path: string) => ({
			path,
			specialUse: null,
			delimiter: "/",
		})),
		renameFolder: vi.fn(
			async (_address: string, _path: string, to: string) => ({
				path: to,
				specialUse: null,
				delimiter: "/",
			}),
		),
		deleteFolder: vi.fn(async () => undefined),
		send: vi.fn<MailWriterBinding["send"]>(async () => sentResult),
	};
	const deleteDraft = vi.fn(async (key: string) => {
		drafts.delete(key);
	});
	const env = {
		MAIL_READER: reader as unknown as MailReaderBinding,
		MAIL_WRITER: writer as unknown as MailWriterBinding,
		OAUTH_KV: {
			get: vi.fn(async (key: string) => drafts.get(key) ?? null),
			put: vi.fn(async (key: string, value: string) => {
				drafts.set(key, value);
			}),
			delete: deleteDraft,
		},
	} as unknown as Env;

	return {
		deleteDraft,
		dispatch: buildDispatchTable(email, env, props),
		drafts,
		reader,
		writer,
	};
}

async function draftNewMail(dispatch: ReturnType<typeof createHarness>["dispatch"]) {
	const drafted = (await dispatch.email_draft!({
		address,
		to: [{ address: "reader@example.com" }],
		subject: "Status",
		body: "The work is complete.",
	})) as { draftId: string };
	return { draftId: drafted.draftId, key: `draft:${drafted.draftId}` };
}

describe("email capabilities", () => {
	it("lists accounts without their server details", async () => {
		const { dispatch } = createHarness();

		await expect(dispatch.email_accounts!({})).resolves.toEqual([
			{ address, label: "personal", senderName: "Oladayo" },
		]);
	});

	it("maps folder changes to the positional writer calls", async () => {
		const { dispatch, writer } = createHarness();

		await expect(
			dispatch.email_mailbox_create!({ address, path: " Projects/Ayo " }),
		).resolves.toMatchObject({ created: true, folder: { path: "Projects/Ayo" } });
		expect(writer.createFolder).toHaveBeenCalledWith(address, "Projects/Ayo");

		await dispatch.email_mailbox_rename!({
			address,
			path: "Projects/Bureau",
			to: "Projects/Ayo",
		});
		expect(writer.renameFolder).toHaveBeenCalledWith(
			address,
			"Projects/Bureau",
			"Projects/Ayo",
		);

		await expect(
			dispatch.email_mailbox_delete!({ address, path: "Projects/Ayo" }),
		).resolves.toEqual({ deleted: true, path: "Projects/Ayo" });
		expect(writer.deleteFolder).toHaveBeenCalledWith(address, "Projects/Ayo");
	});

	it("lets the driver's refusal to delete a folder reach the caller", async () => {
		const { dispatch, writer } = createHarness();
		writer.deleteFolder.mockRejectedValueOnce(
			new Error("The folder INBOX cannot be deleted"),
		);

		await expect(
			dispatch.email_mailbox_delete!({ address, path: "INBOX" }),
		).rejects.toThrow("The folder INBOX cannot be deleted");
	});

	it("rejects invalid mailbox names", async () => {
		const { dispatch } = createHarness();

		await expect(
			dispatch.email_mailbox_create!({ address, path: "Projects\nInjected" }),
		).rejects.toThrow("Mailbox names cannot contain control characters");
	});

	it("lists the tags of one account and tags or untags a batch", async () => {
		const { dispatch, reader, writer } = createHarness();

		await expect(dispatch.email_tags!({ address })).resolves.toEqual([
			{ tag: "needs-reply", count: 2 },
		]);
		expect(reader.listTags).toHaveBeenCalledWith(address);

		const ids = ["message-1", "message-2"];
		await expect(
			dispatch.email_tag!({ address, ids, tag: "receipts" }),
		).resolves.toEqual(batchResult);
		expect(writer.tag).toHaveBeenCalledWith(address, ids, "receipts");

		await dispatch.email_untag!({ address, ids, tag: "urgent" });
		expect(writer.untag).toHaveBeenCalledWith(address, ids, "urgent");
	});

	it("refuses a tag name the writer would reject", async () => {
		const { dispatch, writer } = createHarness();

		await expect(
			dispatch.email_tag!({ address, ids: ["message-1"], tag: "Needs Reply" }),
		).rejects.toThrow();
		expect(writer.tag).not.toHaveBeenCalled();
	});

	it("lists threads with the thread cursor", async () => {
		const { dispatch, reader } = createHarness();
		const options = {
			folder: "INBOX",
			tags: ["needs-reply"],
			unread: true,
			flagged: false,
			limit: 10,
			before: { lastDate: "2026-08-24T00:00:00.000Z", id: "thread-10" },
		};

		await dispatch.email_search!({ kind: "threads", address, ...options });

		expect(reader.listThreads).toHaveBeenCalledWith(address, options);
	});

	it("lists messages when there is no query and searches when there is one", async () => {
		const { dispatch, reader } = createHarness();
		const filters = {
			folder: "Archive",
			from: "bank",
			after: "2026-08-01",
			before: "2026-09-01T00:00:00Z",
			hasAttachments: true,
			tags: ["receipts"],
			flagged: true,
			limit: 20,
		};
		const cursor = { date: null, id: "message-20" };

		await dispatch.email_search!({
			kind: "messages",
			address,
			...filters,
			cursor,
		});
		expect(reader.listMessages).toHaveBeenCalledWith(address, {
			...filters,
			cursor,
		});
		expect(reader.search).not.toHaveBeenCalled();

		await dispatch.email_search!({
			kind: "messages",
			address,
			query: "invoice",
			...filters,
		});
		expect(reader.search).toHaveBeenCalledWith(address, {
			query: "invoice",
			...filters,
		});
		expect(reader.listMessages).toHaveBeenCalledTimes(1);
	});

	it("searches every account when a query has no address", async () => {
		const { dispatch, reader } = createHarness();

		await dispatch.email_search!({ kind: "messages", query: "invoice" });

		expect(reader.search).toHaveBeenCalledWith(null, { query: "invoice" });
	});

	it("rejects search input the reader would silently ignore", async () => {
		const { dispatch, reader } = createHarness();

		// The old filter name: stripping it would return every thread.
		await expect(
			dispatch.email_search!({ kind: "threads", address, starred: true }),
		).rejects.toThrow();
		// A list of all accounts does not exist.
		await expect(
			dispatch.email_search!({ kind: "messages", folder: "INBOX" }),
		).rejects.toThrow("address is required when there is no query");
		// The search has no cursor, so the second page would repeat the first.
		await expect(
			dispatch.email_search!({
				kind: "messages",
				address,
				query: "invoice",
				cursor: { date: null, id: "message-20" },
			}),
		).rejects.toThrow();
		expect(reader.listThreads).not.toHaveBeenCalled();
		expect(reader.listMessages).not.toHaveBeenCalled();
		expect(reader.search).not.toHaveBeenCalled();
	});

	it("reads every message body in a thread", async () => {
		const { dispatch, reader } = createHarness();
		reader.getThread.mockResolvedValueOnce([
			{ id: "message-1" },
			{ id: "message-2" },
		]);
		reader.getMessage
			.mockResolvedValueOnce({ id: "message-1", text: "First body" })
			.mockResolvedValueOnce({ id: "message-2", text: "Second body" });

		await expect(
			dispatch.email_read!({ kind: "thread", address, id: "thread-1" }),
		).resolves.toEqual({
			id: "thread-1",
			messages: [
				{ id: "message-1", text: "First body" },
				{ id: "message-2", text: "Second body" },
			],
		});
		expect(reader.getThread).toHaveBeenCalledWith(address, "thread-1");
		expect(reader.getMessage).toHaveBeenNthCalledWith(1, address, "message-1");
		expect(reader.getMessage).toHaveBeenNthCalledWith(2, address, "message-2");
	});

	it("reports a missing message or thread as an error, not null", async () => {
		const { dispatch, reader } = createHarness();
		reader.getMessage.mockResolvedValueOnce(null);
		reader.getThread.mockResolvedValueOnce(null);

		await expect(
			dispatch.email_read!({ kind: "message", address, id: "message-9" }),
		).resolves.toEqual({
			error: `There is no message message-9 in ${address}.`,
		});
		await expect(
			dispatch.email_read!({ kind: "thread", address, id: "thread-9" }),
		).resolves.toEqual({
			error: `There is no thread thread-9 in ${address}.`,
		});
	});

	it("stores the draft for 24 hours and sends exactly the composed fields", async () => {
		const { dispatch, drafts, writer } = createHarness();
		const preview = {
			address,
			to: [{ address: "reader@example.com", name: "Reader" }],
			cc: [{ address: "copy@example.com" }],
			subject: "Status",
			body: "The work is complete.",
			html: "<p>The work is complete.</p>",
		};

		const drafted = (await dispatch.email_draft!(preview)) as {
			draftId: string;
		};

		expect(drafted).toEqual({ draftId: expect.any(String), preview });
		expect(writer.send).not.toHaveBeenCalled();
		expect(drafts.has(`draft:${drafted.draftId}`)).toBe(true);

		await expect(
			dispatch.email_send!({ draftId: drafted.draftId }),
		).resolves.toEqual({ sent: true, result: sentResult });
		// No third argument for a new mail, and no key the writer does not know.
		expect(writer.send.mock.calls[0]).toHaveLength(2);
		const [sentFrom, mail] = writer.send.mock.calls[0]!;
		expect(sentFrom).toBe(address);
		expect(JSON.parse(JSON.stringify(mail))).toStrictEqual({
			to: preview.to,
			cc: preview.cc,
			subject: "Status",
			text: "The work is complete.",
			html: "<p>The work is complete.</p>",
		});
		expect(drafts.has(`draft:${drafted.draftId}`)).toBe(false);
	});

	it("fills the recipients of a reply from the answered message", async () => {
		const { dispatch, reader, writer } = createHarness();
		reader.getReplyRecipients.mockResolvedValueOnce({
			to: [{ address: "sender@example.com", name: null }],
			cc: [{ address: "team@example.com", name: "Team" }],
		});

		const drafted = (await dispatch.email_draft!({
			address,
			subject: "Re: Status",
			body: "Replying inline.",
			reference: { id: "message-1", action: "replyAll" },
		})) as { draftId: string; preview: { to: unknown; cc: unknown } };

		expect(reader.getReplyRecipients).toHaveBeenCalledWith(
			address,
			"message-1",
			{ all: true },
		);
		expect(drafted.preview.to).toEqual([{ address: "sender@example.com" }]);
		expect(drafted.preview.cc).toEqual([
			{ address: "team@example.com", name: "Team" },
		]);

		await dispatch.email_send!({ draftId: drafted.draftId });
		expect(writer.send).toHaveBeenCalledWith(
			address,
			expect.objectContaining({ to: [{ address: "sender@example.com" }] }),
			{ answers: "message-1" },
		);
	});

	it("keeps the recipients the caller gave for a reply", async () => {
		const { dispatch, reader } = createHarness();
		const to = [{ address: "other@example.com" }];

		const drafted = (await dispatch.email_draft!({
			address,
			to,
			subject: "Re: Status",
			body: "Replying to someone else.",
			reference: { id: "message-1", action: "reply" },
		})) as { preview: { to: unknown } };

		expect(reader.getReplyRecipients).not.toHaveBeenCalled();
		expect(drafted.preview.to).toEqual(to);
	});

	it("forwards with every original attachment by reference", async () => {
		const { dispatch, reader, writer } = createHarness();
		reader.getMessage.mockResolvedValueOnce({
			id: "message-1",
			attachments: [
				{ index: 0, filename: "a.pdf", mimeType: "application/pdf", size: 1 },
				{ index: 1, filename: null, mimeType: "image/png", size: 2 },
			],
		});

		const drafted = (await dispatch.email_draft!({
			address,
			to: [{ address: "reader@example.com" }],
			subject: "Fwd: Status",
			body: "See below.",
			reference: { id: "message-1", action: "forward" },
		})) as { draftId: string; preview: { attachments: unknown } };

		const attachments = [
			{ messageId: "message-1", index: 0 },
			// The writer refuses an unnamed attachment without a filename.
			{ messageId: "message-1", index: 1, filename: "attachment-2" },
		];
		expect(drafted.preview.attachments).toEqual(attachments);

		await dispatch.email_send!({ draftId: drafted.draftId });
		// A forward answers nothing, so the writer gets no `answers`.
		expect(writer.send.mock.calls[0]).toHaveLength(2);
		expect(writer.send.mock.calls[0]![1]).toMatchObject({ attachments });
	});

	it("forwards without the original attachments when the caller passes none", async () => {
		const { dispatch, reader } = createHarness();

		const drafted = (await dispatch.email_draft!({
			address,
			to: [{ address: "reader@example.com" }],
			subject: "Fwd: Status",
			body: "See below.",
			attachments: [],
			reference: { id: "message-1", action: "forward" },
		})) as { preview: { attachments: unknown } };

		expect(drafted.preview.attachments).toEqual([]);
		expect(reader.getMessage).not.toHaveBeenCalled();
	});

	it("keeps the attachments the caller chose for a forward", async () => {
		const { dispatch, reader } = createHarness();

		const drafted = (await dispatch.email_draft!({
			address,
			to: [{ address: "reader@example.com" }],
			subject: "Fwd: Status",
			body: "Only the first file.",
			attachments: [{ messageId: "message-1", index: 0, filename: "a.pdf" }],
			reference: { id: "message-1", action: "forward" },
		})) as { preview: { attachments: unknown } };

		expect(reader.getMessage).not.toHaveBeenCalled();
		expect(drafted.preview.attachments).toEqual([
			{ messageId: "message-1", index: 0, filename: "a.pdf" },
		]);
	});

	it("refuses a draft with no recipient or with attachment bytes", async () => {
		const { dispatch } = createHarness();

		await expect(
			dispatch.email_draft!({
				address,
				subject: "Fwd: Status",
				body: "See below.",
				reference: { id: "message-1", action: "forward" },
			}),
		).rejects.toThrow("to is required unless this is a reply");
		await expect(
			dispatch.email_draft!({
				address,
				to: [{ address: "reader@example.com" }],
				subject: "Status",
				body: "With a file.",
				attachments: [
					{ filename: "a.txt", mimeType: "text/plain", content: "aGk=" },
				],
			}),
		).rejects.toThrow();
	});

	it("clearly refuses an unknown or expired draft", async () => {
		const { deleteDraft, dispatch, writer } = createHarness();

		await expect(
			dispatch.email_send!({ draftId: "missing-draft" }),
		).resolves.toEqual({
			sent: false,
			error: "Email draft missing-draft is unknown or expired.",
		});
		expect(writer.send).not.toHaveBeenCalled();
		expect(deleteDraft).not.toHaveBeenCalled();
	});

	it("keeps the draft when the send is refused", async () => {
		const { dispatch, drafts, writer } = createHarness();
		const { draftId, key } = await draftNewMail(dispatch);
		writer.send.mockResolvedValueOnce({
			status: "refused",
			message: "SMTP login failed",
		});

		await expect(dispatch.email_send!({ draftId })).resolves.toEqual({
			sent: false,
			status: "refused",
			message: "SMTP login failed",
		});
		expect(drafts.has(key)).toBe(true);
	});

	it("removes the draft when the outcome is unknown, so a retry cannot duplicate", async () => {
		const { dispatch, drafts, writer } = createHarness();
		const { draftId, key } = await draftNewMail(dispatch);
		writer.send.mockResolvedValueOnce({
			status: "unknown",
			message: "connection lost",
		});

		const outcome = (await dispatch.email_send!({ draftId })) as {
			sent: boolean;
			status: string;
			message: string;
		};

		expect(outcome).toMatchObject({ sent: false, status: "unknown" });
		expect(outcome.message).toContain("connection lost");
		expect(drafts.has(key)).toBe(false);
		await expect(dispatch.email_send!({ draftId })).resolves.toMatchObject({
			sent: false,
			error: expect.stringContaining("unknown or expired"),
		});
		expect(writer.send).toHaveBeenCalledTimes(1);
	});

	it("removes the draft when the send call throws, so a retry cannot duplicate", async () => {
		const { dispatch, drafts, writer } = createHarness();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const { draftId, key } = await draftNewMail(dispatch);
		// A broken RPC call after the driver started looks the same as this.
		writer.send.mockRejectedValueOnce(new Error("Network connection lost"));

		const outcome = (await dispatch.email_send!({ draftId })) as {
			message: string;
		};

		expect(outcome).toMatchObject({ sent: false, status: "unknown" });
		expect(outcome.message).toContain("Network connection lost");
		expect(drafts.has(key)).toBe(false);
		consoleError.mockRestore();
	});

	it("sends nothing when the draft cannot be consumed first", async () => {
		const { deleteDraft, dispatch, writer } = createHarness();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const { draftId } = await draftNewMail(dispatch);
		deleteDraft.mockRejectedValueOnce(new Error("KV unavailable"));

		await expect(dispatch.email_send!({ draftId })).rejects.toThrow(
			"KV unavailable",
		);
		expect(writer.send).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("rejects a misspelled folder and a \\Deleted flag instead of widening the action", async () => {
		const { dispatch, writer } = createHarness();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const ids = ["message-1"];

		await expect(
			dispatch.email_trash!({ address, ids, mailbox: "Junk" }),
		).rejects.toThrow();
		await expect(
			dispatch.email_flag!({ address, ids, add: ["\\Deleted"] }),
		).rejects.toThrow();
		expect(writer.trashMessages).not.toHaveBeenCalled();
		expect(writer.setFlags).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("maps move, trash and flag to the positional writer calls", async () => {
		const { dispatch, writer } = createHarness();
		const ids = ["message-1", "message-2"];

		await expect(
			dispatch.email_move!({ address, ids, to: "Archive" }),
		).resolves.toEqual(batchResult);
		expect(writer.moveMessages).toHaveBeenLastCalledWith(address, ids, "Archive");
		await dispatch.email_move!({ address, ids, to: "INBOX", folder: "Junk" });
		expect(writer.moveMessages).toHaveBeenLastCalledWith(address, ids, "INBOX", {
			folder: "Junk",
		});

		await dispatch.email_trash!({ address, ids });
		expect(writer.trashMessages).toHaveBeenLastCalledWith(address, ids);
		await dispatch.email_trash!({ address, ids, folder: "Junk" });
		expect(writer.trashMessages).toHaveBeenLastCalledWith(address, ids, {
			folder: "Junk",
		});

		await dispatch.email_flag!({
			address,
			ids,
			add: ["\\Flagged"],
			remove: ["\\Seen"],
		});
		expect(writer.setFlags).toHaveBeenCalledWith(address, ids, {
			add: ["\\Flagged"],
			remove: ["\\Seen"],
		});
	});

	it("reports the missing backend rather than throwing", async () => {
		const dispatch = buildDispatchTable(email, {} as Env, props);

		await expect(dispatch.email_mailboxes!({ address })).resolves.toEqual({
			error: "The email backend is not configured.",
		});
		await expect(
			dispatch.email_trash!({ address, ids: ["message-1"] }),
		).resolves.toEqual({ error: "The email backend is not configured." });
	});
});
