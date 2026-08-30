import { describe, expect, it, vi } from "vitest";
import { email } from "../src/capabilities/email";
import type { BureauBinding, Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

function createHarness() {
	const drafts = new Map<string, string>();
	const staged = new Map<string, string>();
	const bureau = {
		createMailbox: vi.fn(async ({ path }: { path: string }) => ({ path })),
		renameMailbox: vi.fn(async ({ to }: { to: string }) => ({ path: to })),
		deleteMailbox: vi.fn(async ({ path }: { path: string }) => ({ path })),
		createTag: vi.fn(async () => ({
			id: "66666666-6666-4666-8666-666666666666",
			name: "Receipts",
			keyword: "Receipts",
			color: null,
			createdAt: "2026-08-27T00:00:00Z",
		})),
		updateTag: vi.fn(),
		deleteTag: vi.fn(async () => ({
			id: "55555555-5555-4555-8555-555555555555",
		})),
		listTags: vi.fn(async () => [
			{
				id: "55555555-5555-4555-8555-555555555555",
				name: "Receipts",
				keyword: "AyoReceipts",
				color: "#00aa55",
				createdAt: "2026-08-27T00:00:00Z",
			},
		]),
		listAccounts: vi.fn(async () => [
			{ address: "oladayo@example.com", primary: true },
		]),
		listMailboxes: vi.fn(async () => [
			{
				path: "INBOX",
				// Bureau has no \Inbox attribute: the inbox is the INBOX path.
				name: "INBOX",
				specialUse: null,
				delimiter: "/",
				noselect: false,
				messages: 12,
				unseen: 3,
			},
			{
				path: "Archive",
				name: "Archive",
				specialUse: null,
				delimiter: "/",
				noselect: true,
			},
			{
				path: "Archive/2026",
				name: "2026",
				specialUse: "\\Archive",
				delimiter: "/",
				noselect: false,
			},
		]),
		listThreads: vi.fn(async () => []),
		listMessages: vi.fn(async () => []),
		getThread: vi.fn(),
		getMessage: vi.fn(),
		moveMessage: vi.fn(),
		setMessageFlags: vi.fn(),
		send: vi.fn(async () => ({
			id: "sent-message",
			threadId: "sent-thread",
			messageId: "<sent@example.com>",
			rejected: [],
		})),
	} as unknown as BureauBinding;
	const put = vi.fn(
		async (key: string, value: string, _options?: { expirationTtl: number }) => {
			drafts.set(key, value);
		},
	);
	const deleteDraft = vi.fn(async (key: string) => {
		drafts.delete(key);
	});
	const deleteConfirmation = vi.fn(async (key: string) => {
		staged.delete(key);
	});
	const env = {
		BUREAU: bureau,
		OAUTH_KV: {
			get: vi.fn(
				async (key: string) => drafts.get(key) ?? staged.get(key) ?? null,
			),
			put: vi.fn(
				async (key: string, value: string, options?: { expirationTtl: number }) => {
					if (key.startsWith("confirm:")) staged.set(key, value);
					else await put(key, value, options);
				},
			),
			delete: vi.fn(async (key: string) => {
				if (key.startsWith("confirm:")) await deleteConfirmation(key);
				else await deleteDraft(key);
			}),
		},
	} as unknown as Env;

	return {
		bureau,
		deleteConfirmation,
		deleteDraft,
		dispatch: buildDispatchTable(email, env, props),
		drafts,
		put,
		staged,
	};
}

describe("email capabilities", () => {
	it("creates a folder only through the confirmation gate", async () => {
		const { bureau, deleteConfirmation, dispatch, staged } = createHarness();

		const stagedCreate = (await dispatch.email_mailbox_create!({
			address: "oladayo@example.com",
			path: " Projects/Ayo ",
		})) as { confirmId: string; created: boolean; preview: unknown };
		expect(stagedCreate).toMatchObject({
			created: false,
			preview: {
				address: "oladayo@example.com",
				path: "Projects/Ayo",
			},
		});
		expect(bureau.createMailbox).not.toHaveBeenCalled();

		await expect(
			dispatch.email_mailbox_create!({ confirmId: stagedCreate.confirmId }),
		).resolves.toEqual({
			created: true,
			folder: { path: "Projects/Ayo" },
		});
		expect(bureau.createMailbox).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			path: "Projects/Ayo",
		});
		expect(deleteConfirmation).toHaveBeenCalledWith(
			`confirm:email_mailbox_create:${stagedCreate.confirmId}`,
		);
		expect(staged.size).toBe(0);
	});

	it("renames a folder only through the confirmation gate", async () => {
		const { bureau, dispatch, staged } = createHarness();
		const change = {
			address: "oladayo@example.com",
			path: "Projects/Bureau",
			to: "Projects/Ayo",
		};

		const stagedRename = (await dispatch.email_mailbox_rename!(change)) as {
			confirmId: string;
			renamed: boolean;
			preview: unknown;
		};
		expect(stagedRename).toMatchObject({ renamed: false, preview: change });
		expect(bureau.renameMailbox).not.toHaveBeenCalled();

		await expect(
			dispatch.email_mailbox_rename!({ confirmId: stagedRename.confirmId }),
		).resolves.toEqual({
			renamed: true,
			folder: { path: "Projects/Ayo" },
		});
		expect(bureau.renameMailbox).toHaveBeenCalledWith(change);
		expect(staged.size).toBe(0);
	});

	it("refuses to stage deleting an unlisted folder", async () => {
		const { bureau, dispatch, staged } = createHarness();

		await expect(
			dispatch.email_mailbox_delete!({
				address: "oladayo@example.com",
				path: "Missing",
			}),
		).resolves.toEqual({
			deleted: false,
			error: "No folder with path Missing is listed for oladayo@example.com.",
		});
		expect(bureau.deleteMailbox).not.toHaveBeenCalled();
		expect(staged.size).toBe(0);
	});

	it("previews and deletes a listed folder through confirmation", async () => {
		const { bureau, dispatch, staged } = createHarness();
		const target = {
			address: "oladayo@example.com",
			path: "Archive/2026",
		};

		const stagedDelete = (await dispatch.email_mailbox_delete!(target)) as {
			confirmId: string;
			deleted: boolean;
			preview: unknown;
		};
		expect(stagedDelete).toMatchObject({
			deleted: false,
			preview: target,
		});
		expect(bureau.deleteMailbox).not.toHaveBeenCalled();

		await expect(
			dispatch.email_mailbox_delete!({ confirmId: stagedDelete.confirmId }),
		).resolves.toEqual({ deleted: true, path: "Archive/2026" });
		expect(bureau.deleteMailbox).toHaveBeenCalledWith(target);
		expect(staged.size).toBe(0);

		await expect(
			dispatch.email_mailbox_delete!({ confirmId: stagedDelete.confirmId }),
		).resolves.toMatchObject({ deleted: false, error: expect.any(String) });
		expect(bureau.deleteMailbox).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid mailbox names before staging", async () => {
		const { dispatch, staged } = createHarness();

		await expect(
			dispatch.email_mailbox_create!({
				address: "oladayo@example.com",
				path: "Projects\nInjected",
			}),
		).rejects.toThrow("Mailbox names cannot contain control characters");
		expect(staged.size).toBe(0);
	});

	it("lists the tag registry and filters threads by tag", async () => {
		const { bureau, dispatch } = createHarness();

		const tags = (await dispatch.email_tags!({})) as Array<{
			keyword: string;
		}>;
		expect(tags[0]?.keyword).toBe("AyoReceipts");
		expect(bureau.listTags).toHaveBeenCalledWith({});

		await dispatch.email_search!({
			kind: "threads",
			address: "oladayo@example.com",
			tag: "55555555-5555-4555-8555-555555555555",
		});
		expect(bureau.listThreads).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			tag: "55555555-5555-4555-8555-555555555555",
		});
	});

	it("creates and deletes tags only through the confirmation gate", async () => {
		const { bureau, dispatch } = createHarness();

		const stagedCreate = (await dispatch.email_tag_create!({
			name: "Receipts",
		})) as { confirmId: string; created: boolean };
		expect(stagedCreate.created).toBe(false);
		expect(bureau.createTag).not.toHaveBeenCalled();

		await expect(
			dispatch.email_tag_create!({ confirmId: stagedCreate.confirmId }),
		).resolves.toMatchObject({ created: true });
		expect(bureau.createTag).toHaveBeenCalledWith({ name: "Receipts" });

		const stagedDelete = (await dispatch.email_tag_delete!({
			id: "55555555-5555-4555-8555-555555555555",
		})) as { confirmId: string; preview: unknown };
		expect(stagedDelete.preview).toEqual({
			id: "55555555-5555-4555-8555-555555555555",
			name: "Receipts",
			keyword: "AyoReceipts",
		});
		expect(bureau.deleteTag).not.toHaveBeenCalled();

		await expect(
			dispatch.email_tag_delete!({ confirmId: stagedDelete.confirmId }),
		).resolves.toEqual({
			deleted: true,
			id: "55555555-5555-4555-8555-555555555555",
		});

		const reused = (await dispatch.email_tag_delete!({
			confirmId: stagedDelete.confirmId,
		})) as { deleted: boolean; error: string };
		expect(reused.deleted).toBe(false);
		expect(reused.error).toContain("unknown or expired");
	});

	it("updates a tag only through the confirmation gate", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.updateTag).mockResolvedValueOnce({
			id: "55555555-5555-4555-8555-555555555555",
			name: "Invoices",
			keyword: "AyoReceipts",
			color: "#112233",
			createdAt: "2026-08-27T00:00:00Z",
		});

		const stagedUpdate = (await dispatch.email_tag_update!({
			id: "55555555-5555-4555-8555-555555555555",
			name: "Invoices",
			color: "#112233",
		})) as { confirmId: string; updated: boolean; preview: unknown };
		expect(stagedUpdate.updated).toBe(false);
		expect(bureau.updateTag).not.toHaveBeenCalled();

		await expect(
			dispatch.email_tag_update!({ confirmId: stagedUpdate.confirmId }),
		).resolves.toMatchObject({ updated: true });
		expect(bureau.updateTag).toHaveBeenCalledWith({
			id: "55555555-5555-4555-8555-555555555555",
			name: "Invoices",
			color: "#112233",
		});

		const reused = (await dispatch.email_tag_update!({
			confirmId: stagedUpdate.confirmId,
		})) as { updated: boolean; error: string };
		expect(reused.updated).toBe(false);
		expect(reused.error).toContain("unknown or expired");
		expect(bureau.updateTag).toHaveBeenCalledTimes(1);
	});

	it("refuses to stage deleting an unknown tag", async () => {
		const { bureau, dispatch } = createHarness();

		const result = (await dispatch.email_tag_delete!({
			id: "99999999-9999-4999-8999-999999999999",
		})) as { deleted: boolean; error: string };
		expect(result.deleted).toBe(false);
		expect(result.error).toContain("No tag");
		expect(bureau.deleteTag).not.toHaveBeenCalled();
	});

	it("stores the user-facing preview and maps its body only when sending", async () => {
		const { bureau, deleteDraft, dispatch, drafts, put } = createHarness();
		const preview = {
			address: "oladayo@example.com",
			to: [{ address: "reader@example.com", name: "Reader" }],
			cc: [{ address: "copy@example.com" }],
			subject: "Status",
			body: "The work is complete.",
		};

		const drafted = (await dispatch.email_draft!(preview)) as {
			draftId: string;
			preview: typeof preview;
		};

		expect(drafted).toEqual({ draftId: expect.any(String), preview });
		expect(bureau.send).not.toHaveBeenCalled();
		expect(put).toHaveBeenCalledWith(
			`draft:${drafted.draftId}`,
			JSON.stringify(preview),
			{ expirationTtl: 86_400 },
		);

		await expect(
			dispatch.email_send!({ draftId: drafted.draftId }),
		).resolves.toEqual({
			sent: true,
			result: {
				id: "sent-message",
				threadId: "sent-thread",
				messageId: "<sent@example.com>",
				rejected: [],
			},
		});
		expect(bureau.send).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			to: [{ address: "reader@example.com", name: "Reader" }],
			cc: [{ address: "copy@example.com" }],
			subject: "Status",
			text: "The work is complete.",
		});
		expect(deleteDraft).toHaveBeenCalledWith(`draft:${drafted.draftId}`);
		expect(drafts.has(`draft:${drafted.draftId}`)).toBe(false);
	});

	it("clearly refuses an unknown or expired draft", async () => {
		const { bureau, deleteDraft, dispatch } = createHarness();
		const draftId = "missing-draft";

		await expect(dispatch.email_send!({ draftId })).resolves.toEqual({
			sent: false,
			error: `Email draft ${draftId} is unknown or expired.`,
		});
		expect(bureau.send).not.toHaveBeenCalled();
		expect(deleteDraft).not.toHaveBeenCalled();
	});

	it("retains a draft when sending fails", async () => {
		const { bureau, deleteDraft, dispatch, drafts } = createHarness();
		const drafted = (await dispatch.email_draft!({
			address: "oladayo@example.com",
			to: [{ address: "reader@example.com" }],
			subject: "Status",
			body: "The work is complete.",
		})) as { draftId: string };
		vi.mocked(bureau.send).mockRejectedValueOnce(new Error("SMTP unavailable"));

		await expect(
			dispatch.email_send!({ draftId: drafted.draftId }),
		).rejects.toThrow("SMTP unavailable");
		expect(deleteDraft).not.toHaveBeenCalled();
		expect(drafts.has(`draft:${drafted.draftId}`)).toBe(true);
	});

	it("carries a reply reference from draft to send", async () => {
		const { bureau, dispatch } = createHarness();
		const drafted = (await dispatch.email_draft!({
			address: "oladayo@example.com",
			to: [{ address: "reader@example.com" }],
			subject: "Re: Status",
			body: "Replying inline.",
			reference: { id: "message-1", action: "reply" },
		})) as { draftId: string };

		await dispatch.email_send!({ draftId: drafted.draftId });
		expect(bureau.send).toHaveBeenCalledWith(
			expect.objectContaining({
				reference: { id: "message-1", action: "reply" },
			}),
		);
	});

	it("still reports success when draft cleanup fails after the send", async () => {
		const { bureau, deleteDraft, dispatch } = createHarness();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const drafted = (await dispatch.email_draft!({
			address: "oladayo@example.com",
			to: [{ address: "reader@example.com" }],
			subject: "Status",
			body: "The work is complete.",
		})) as { draftId: string };
		vi.mocked(deleteDraft).mockRejectedValueOnce(new Error("KV unavailable"));

		await expect(
			dispatch.email_send!({ draftId: drafted.draftId }),
		).resolves.toMatchObject({ sent: true });
		expect(bureau.send).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith(
			"ayo email draft cleanup failed",
			expect.any(Error),
		);
		consoleError.mockRestore();
	});

	it("reads every message body in a thread", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.getThread).mockResolvedValueOnce({
			id: "thread-1",
			subject: "Planning",
			messages: [{ id: "message-1" }, { id: "message-2" }],
		});
		vi.mocked(bureau.getMessage)
			.mockResolvedValueOnce({ id: "message-1", text: "First body", html: null })
			.mockResolvedValueOnce({
				id: "message-2",
				text: "Second body",
				html: "<p>Second body</p>",
			});

		await expect(
			dispatch.email_read!({
				kind: "thread",
				address: "oladayo@example.com",
				id: "thread-1",
			}),
		).resolves.toMatchObject({
			id: "thread-1",
			subject: "Planning",
			messages: [
				{ id: "message-1", text: "First body", html: null },
				{
					id: "message-2",
					text: "Second body",
					html: "<p>Second body</p>",
				},
			],
		});
		expect(bureau.getThread).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			id: "thread-1",
		});
		expect(bureau.getMessage).toHaveBeenNthCalledWith(1, {
			address: "oladayo@example.com",
			id: "message-1",
		});
		expect(bureau.getMessage).toHaveBeenNthCalledWith(2, {
			address: "oladayo@example.com",
			id: "message-2",
		});
	});

	it("reads one message body directly", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.getMessage).mockResolvedValueOnce({
			id: "message-1",
			text: "Message body",
			html: null,
		});

		await expect(
			dispatch.email_read!({
				kind: "message",
				address: "oladayo@example.com",
				id: "message-1",
			}),
		).resolves.toEqual({
			id: "message-1",
			text: "Message body",
			html: null,
		});
		expect(bureau.getMessage).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			id: "message-1",
		});
		expect(bureau.getThread).not.toHaveBeenCalled();
	});

	it("forwards both email search modes with exact Bureau RPC shapes", async () => {
		const { bureau, dispatch } = createHarness();

		await dispatch.email_search!({
			kind: "threads",
			address: "oladayo@example.com",
			folder: "INBOX",
			starred: true,
			limit: 10,
			before: "2026-08-24T00:00:00.000Z",
			beforeId: "thread-10",
		});
		await dispatch.email_search!({
			kind: "messages",
			address: "oladayo@example.com",
			folder: "Archive",
			threadId: "thread-10",
			limit: 20,
			before: "2026-08-23T00:00:00.000Z",
		});

		expect(bureau.listThreads).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			folder: "INBOX",
			starred: true,
			limit: 10,
			before: "2026-08-24T00:00:00.000Z",
			beforeId: "thread-10",
		});
		expect(bureau.listMessages).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			folder: "Archive",
			threadId: "thread-10",
			limit: 20,
			before: "2026-08-23T00:00:00.000Z",
		});
	});

	it("forwards move and flag inputs with exact Bureau RPC shapes", async () => {
		const { bureau, dispatch } = createHarness();

		await dispatch.email_move!({
			address: "oladayo@example.com",
			id: "message-1",
			to: "Archive",
		});
		await dispatch.email_flag!({
			address: "oladayo@example.com",
			id: "message-1",
			add: ["\\Flagged"],
			remove: ["\\Seen"],
		});

		expect(bureau.moveMessage).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			id: "message-1",
			to: "Archive",
		});
		expect(bureau.setMessageFlags).toHaveBeenCalledWith({
			address: "oladayo@example.com",
			id: "message-1",
			add: ["\\Flagged"],
			remove: ["\\Seen"],
		});
	});

	it("lists the account's mailboxes so a folder path can be chosen", async () => {
		const { bureau, dispatch } = createHarness();

		const mailboxes = (await dispatch.email_mailboxes!({
			address: "oladayo@example.com",
		})) as Array<{ path: string; specialUse: string | null; noselect: boolean }>;

		// Passed through unfiltered, noselect included: the description tells the
		// agent what noselect means rather than hiding a real mailbox path.
		expect(mailboxes.map((mailbox) => mailbox.path)).toEqual([
			"INBOX",
			"Archive",
			"Archive/2026",
		]);
		expect(mailboxes[0]?.specialUse).toBeNull();
		expect(mailboxes[1]?.noselect).toBe(true);
		expect(mailboxes[2]?.specialUse).toBe("\\Archive");
		expect(bureau.listMailboxes).toHaveBeenCalledWith({
			address: "oladayo@example.com",
		});
	});

	it("reports the missing backend rather than throwing", async () => {
		const dispatch = buildDispatchTable(email, {} as Env, props);

		await expect(
			dispatch.email_mailboxes!({ address: "oladayo@example.com" }),
		).resolves.toEqual({ error: "The email backend is not configured." });
	});
});
