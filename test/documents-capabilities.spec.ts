import { env as bindings } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { documents } from "../src/capabilities/documents";
import type { Env, FilesBinding, OwnerProps, PublicDocument } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

const documentId = "11111111-1111-4111-8111-111111111111";
const folderId = "22222222-2222-4222-8222-222222222222";
const tagId = "33333333-3333-4333-8333-333333333333";
const otherTagId = "44444444-4444-4444-8444-444444444444";

const document: PublicDocument = {
	id: documentId,
	title: "Invoice",
	titleOverride: "Invoice",
	originalName: "invoice.pdf",
	mimeType: "application/pdf",
	size: 12_345,
	checksum: "sha256:abc",
	folderId,
	folder: { id: folderId, name: "Taxes", path: "Finance/Taxes" },
	tags: [{ id: tagId, name: "Receipts" }],
	correspondent: "Acme",
	type: "invoice",
	receivedOn: "2026-08-01",
	notes: null,
	processingStatus: "completed",
	ocrStatus: "completed",
	ocrText: "Full OCR text",
	ocrError: null,
	pageCount: 2,
	ocrCompletedAt: "2026-08-01T00:05:00Z",
	preview: { kind: "pdf" },
	createdAt: "2026-08-01T00:00:00Z",
	updatedAt: "2026-08-01T00:10:00Z",
	deletedAt: null,
};

const summary = {
	id: documentId,
	title: "Invoice",
	originalName: "invoice.pdf",
	mimeType: "application/pdf",
	size: 12_345,
	folder: "Finance/Taxes",
	tags: ["Receipts"],
	correspondent: "Acme",
	type: "invoice",
	receivedOn: "2026-08-01",
	processingStatus: "completed",
	ocrStatus: "completed",
	trashed: false,
};

function createHarness() {
	const page = { documents: [document], nextCursor: "cursor-2" };
	const files = {
		listDocuments: vi.fn(async () => page),
		searchDocuments: vi.fn(async () => page),
		getDocument: vi.fn(async () => document),
		listCorrespondents: vi.fn(async () => ["Acme", "Stadtwerke"]),
		updateDocument: vi.fn(async () => document),
		updateDocumentTags: vi.fn(async () => document),
		changeDocumentTags: vi.fn(async () => document),
		moveDocuments: vi.fn(async () => [document]),
		trashDocuments: vi.fn(async () => [document]),
		restoreDocument: vi.fn(async () => document),
		retryDocumentProcessing: vi.fn(async () => document),
		listDocumentFolders: vi.fn(async () => [
			{ id: folderId, name: "Taxes", path: "Finance/Taxes", parentId: null },
		]),
		createDocumentFolder: vi.fn(async () => ({
			id: folderId,
			name: "Taxes",
			path: "Taxes",
			parentId: null,
		})),
		updateDocumentFolder: vi.fn(async () => ({
			id: folderId,
			name: "Taxes 2026",
			path: "Taxes 2026",
			parentId: null,
		})),
		deleteDocumentFolder: vi.fn(async () => ({ id: folderId })),
		listDocumentTags: vi.fn(async () => [{ id: tagId, name: "Receipts" }]),
		createDocumentTag: vi.fn(async () => ({ id: tagId, name: "Receipts" })),
		updateDocumentTag: vi.fn(async () => ({ id: tagId, name: "Invoices" })),
		deleteDocumentTag: vi.fn(async () => ({ id: tagId })),
		uploadDocument: vi.fn(),
		getDocumentFile: vi.fn(),
		getDocumentPreview: vi.fn(),
	} as unknown as FilesBinding;
	const env = {
		PUBLIC_BASE_URL: "https://myspace.oflabs.dev",
		FILES: files,
		JOBS_DB: bindings.JOBS_DB,
	} as unknown as Env;

	return { files, dispatch: buildDispatchTable(documents, env, props) };
}

describe("documents capabilities", () => {
	it("lists documents until a query is given, then searches", async () => {
		const { files, dispatch } = createHarness();

		await dispatch.document_search!({ folderId: "unfiled", limit: 10 });
		expect(files.listDocuments).toHaveBeenCalledWith({
			folderId: "unfiled",
			limit: 10,
		});
		expect(files.searchDocuments).not.toHaveBeenCalled();

		await dispatch.document_search!({ query: "invoice", types: ["invoice"] });
		expect(files.searchDocuments).toHaveBeenCalledWith({
			query: "invoice",
			types: ["invoice"],
		});
	});

	it("passes every contract filter through unchanged", async () => {
		const { files, dispatch } = createHarness();
		const filters = {
			folderId,
			tagIds: [tagId],
			correspondents: ["Acme"],
			types: ["invoice", "statement"],
			ocrStatuses: ["completed"],
			processingStatuses: ["pending", "failed"],
			receivedFrom: "2026-01-01",
			receivedTo: "2026-12-31",
			trashed: true,
			limit: 200,
			cursor: "cursor-1",
		};

		await dispatch.document_search!(filters);

		expect(files.listDocuments).toHaveBeenCalledWith(filters);
	});

	it("adapts a result page to compact summaries and the cursor", async () => {
		const { dispatch } = createHarness();

		await expect(dispatch.document_search!({})).resolves.toEqual({
			documents: [summary],
			nextCursor: "cursor-2",
		});
	});

	it("refuses a received range that runs backwards, and an over-large limit", async () => {
		const { dispatch } = createHarness();

		await expect(
			dispatch.document_search!({
				receivedFrom: "2026-12-31",
				receivedTo: "2026-01-01",
			}),
		).rejects.toThrow("receivedFrom must not be later than receivedTo");
		await expect(dispatch.document_search!({ limit: 201 })).rejects.toThrow();
	});

	it("reads one document with its full OCR text", async () => {
		const { files, dispatch } = createHarness();

		await expect(dispatch.document_read!({ id: documentId })).resolves.toEqual(
			document,
		);
		expect(files.getDocument).toHaveBeenCalledWith({ id: documentId });
	});

	it("reports a missing document rather than throwing", async () => {
		const { files, dispatch } = createHarness();
		vi.mocked(files.getDocument).mockResolvedValueOnce(null);

		await expect(dispatch.document_read!({ id: documentId })).resolves.toEqual({
			error: "The document was not found.",
		});
	});

	it("maps the update input straight onto updateDocument", async () => {
		const { files, dispatch } = createHarness();
		const update = {
			id: documentId,
			title: "Acme invoice",
			correspondent: "Acme",
			type: "invoice",
			receivedOn: "2026-08-01",
			notes: null,
		};

		await dispatch.document_update!(update);

		expect(files.updateDocument).toHaveBeenCalledWith(update);
	});

	it("requires at least one field to update and a known document type", async () => {
		const { dispatch } = createHarness();

		await expect(dispatch.document_update!({ id: documentId })).rejects.toThrow(
			"At least one document field is required",
		);
		await expect(
			dispatch.document_update!({ id: documentId, type: "postcard" }),
		).rejects.toThrow();
	});

	it("summarises the documents that move and trash return", async () => {
		const { files, dispatch } = createHarness();

		await expect(
			dispatch.document_move!({ ids: [documentId], folderId }),
		).resolves.toEqual([summary]);
		expect(files.moveDocuments).toHaveBeenCalledWith({
			ids: [documentId],
			folderId,
		});

		await expect(
			dispatch.document_trash!({ ids: [documentId] }),
		).resolves.toEqual([summary]);
		expect(files.trashDocuments).toHaveBeenCalledWith({ ids: [documentId] });
	});

	it("lists the correspondents the archive knows", async () => {
		const { files, dispatch } = createHarness();

		await expect(dispatch.document_correspondents!({})).resolves.toEqual([
			"Acme",
			"Stadtwerke",
		]);
		expect(files.listCorrespondents).toHaveBeenCalledWith({});
	});

	it("manages folders end to end", async () => {
		const { files, dispatch } = createHarness();

		await dispatch.document_folder_create!({ name: "Taxes" });
		expect(files.createDocumentFolder).toHaveBeenCalledWith({ name: "Taxes" });

		await dispatch.document_folder_update!({ id: folderId, name: "Taxes 2026" });
		expect(files.updateDocumentFolder).toHaveBeenCalledWith({
			id: folderId,
			name: "Taxes 2026",
		});

		await dispatch.document_folder_delete!({ id: folderId });
		expect(files.deleteDocumentFolder).toHaveBeenCalledWith({ id: folderId });
	});

	it("manages the tag registry end to end", async () => {
		const { files, dispatch } = createHarness();

		await dispatch.document_tag_create!({ name: "Receipts" });
		expect(files.createDocumentTag).toHaveBeenCalledWith({ name: "Receipts" });

		await dispatch.document_tag_update!({ id: tagId, name: "Invoices" });
		expect(files.updateDocumentTag).toHaveBeenCalledWith({
			id: tagId,
			name: "Invoices",
		});

		await dispatch.document_tag_delete!({ id: tagId });
		expect(files.deleteDocumentTag).toHaveBeenCalledWith({ id: tagId });
	});

	it("replaces a document's whole tag set, including clearing it", async () => {
		const { files, dispatch } = createHarness();

		await dispatch.document_tags_set!({ id: documentId, tagIds: [tagId] });
		expect(files.updateDocumentTags).toHaveBeenCalledWith({
			id: documentId,
			tagIds: [tagId],
		});

		await dispatch.document_tags_set!({ id: documentId, tagIds: [] });
		expect(files.updateDocumentTags).toHaveBeenLastCalledWith({
			id: documentId,
			tagIds: [],
		});
	});

	it("applies additions and removals in a single atomic call", async () => {
		const { files, dispatch } = createHarness();
		const finalDocument = { ...document, tags: [{ id: otherTagId, name: "Tax" }] };
		vi.mocked(files.changeDocumentTags).mockResolvedValueOnce(finalDocument);

		await expect(
			dispatch.document_tags_update!({
				id: documentId,
				addTagIds: [otherTagId],
				removeTagIds: [tagId],
			}),
		).resolves.toEqual(finalDocument);

		expect(files.changeDocumentTags).toHaveBeenCalledTimes(1);
		expect(files.changeDocumentTags).toHaveBeenCalledWith({
			id: documentId,
			addTagIds: [otherTagId],
			removeTagIds: [tagId],
		});
	});

	it("makes only the one call a one-sided tag change needs", async () => {
		const { files, dispatch } = createHarness();

		await dispatch.document_tags_update!({
			id: documentId,
			addTagIds: [tagId],
		});

		expect(files.changeDocumentTags).toHaveBeenCalledTimes(1);
		expect(files.changeDocumentTags).toHaveBeenCalledWith({
			id: documentId,
			addTagIds: [tagId],
		});
	});

	it("refuses tagging with nothing to change, or the same tag on both sides", async () => {
		const { dispatch } = createHarness();

		await expect(dispatch.document_tags_update!({ id: documentId })).rejects.toThrow(
			"Provide at least one tag to add or remove",
		);
		await expect(
			dispatch.document_tags_update!({
				id: documentId,
				addTagIds: [tagId],
				removeTagIds: [tagId],
			}),
		).rejects.toThrow("The same tag cannot be added and removed");
	});

	it("mints a single-use upload ticket restricted to declared filename, mime, and size", async () => {
		const { dispatch } = createHarness();

		const upload = (await dispatch.document_upload!({
			filename: "receipt.pdf",
			mime: "application/pdf",
			size: 1_000,
		})) as { uploadUrl: string; method: string; maxSizeBytes: number };

		expect(upload.method).toBe("PUT");
		expect(upload.uploadUrl).toMatch(
			/^https:\/\/myspace\.oflabs\.dev\/documents\/upload\/[A-Za-z0-9_-]{43}$/,
		);
		expect(upload.maxSizeBytes).toBe(50 * 1024 * 1024);
	});

	it("rejects an upload whose extension does not match its declared mime type", async () => {
		const { dispatch } = createHarness();

		await expect(
			dispatch.document_upload!({
				filename: "receipt.png",
				mime: "application/pdf",
				size: 1_000,
			}),
		).rejects.toThrow("The filename's extension must match the declared mime type");
	});

	it("mints a single-use download ticket carrying the document's file metadata", async () => {
		const { dispatch } = createHarness();

		const download = (await dispatch.document_file!({ id: documentId })) as {
			downloadUrl: string;
			variant: string;
			filename: string;
			mimeType: string | null;
			size: number | null;
			previewKind: string;
		};

		expect(download.downloadUrl).toMatch(
			/^https:\/\/myspace\.oflabs\.dev\/documents\/file\/[A-Za-z0-9_-]{43}$/,
		);
		expect(download.variant).toBe("original");
		expect(download.filename).toBe("invoice.pdf");
		expect(download.mimeType).toBe("application/pdf");
		expect(download.size).toBe(12_345);
		expect(download.previewKind).toBe("pdf");
	});

	it("mints a preview ticket without claiming the original's mime type or size", async () => {
		const { dispatch } = createHarness();

		const download = (await dispatch.document_file!({
			id: documentId,
			variant: "preview",
		})) as { variant: string; mimeType: string | null; size: number | null };

		expect(download.variant).toBe("preview");
		expect(download.mimeType).toBeNull();
		expect(download.size).toBeNull();
	});

	it("does not mint a download ticket for a missing document", async () => {
		const { files, dispatch } = createHarness();
		vi.mocked(files.getDocument).mockResolvedValueOnce(null);
		const before = await bindings.JOBS_DB.prepare(
			"SELECT COUNT(*) AS count FROM document_tickets WHERE kind = 'download'",
		).first<{ count: number }>();

		await expect(dispatch.document_file!({ id: documentId })).resolves.toEqual({
			error: "The document was not found.",
		});
		const after = await bindings.JOBS_DB.prepare(
			"SELECT COUNT(*) AS count FROM document_tickets WHERE kind = 'download'",
		).first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
	});

	it("reports the missing backend rather than throwing", async () => {
		const dispatch = buildDispatchTable(documents, {} as Env, props);

		await expect(dispatch.document_search!({})).resolves.toEqual({
			error: "The documents backend is not configured.",
		});
	});
});
