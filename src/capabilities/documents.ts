import { z } from "zod";
import { documentFileUrl, documentUploadUrl } from "../documents/links";
import { createTicket } from "../documents/tickets";
import type { PublicDocumentSummary } from "../env";
import type { Capability } from "./index";

const BACKEND_NOT_CONFIGURED = "The documents backend is not configured.";
const NOT_FOUND = "The document was not found.";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Matches Bureau's document processing pipeline: the OCR path only
// understands these. There is no thumbnail generation; the original file
// provides its own preview wherever the browser can render it.
const ALLOWED_UPLOAD_MIME_TYPES = {
	"application/pdf": ["pdf"],
	"image/png": ["png"],
	"image/jpeg": ["jpg", "jpeg"],
	"image/tiff": ["tif", "tiff"],
} as const;

const DOCUMENT_TYPES = [
	"invoice",
	"contract",
	"notice",
	"statement",
	"reminder",
	"letter",
	"other",
] as const;
const PROCESSING_STATUSES = [
	"pending",
	"processing",
	"completed",
	"failed",
] as const;

const idSchema = z.uuid();
const resourceSchema = z.object({ id: idSchema });
const idsSchema = z.array(idSchema).min(1).max(100);
const tagIdsSchema = z.array(idSchema).max(50);

const listInputSchema = z
	.object({
		query: z.string().min(1).max(500).optional(),
		folderId: z.union([idSchema, z.literal("unfiled")]).optional(),
		tagIds: z.array(idSchema).min(1).max(50).optional(),
		correspondents: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
		types: z.array(z.enum(DOCUMENT_TYPES)).min(1).optional(),
		ocrStatuses: z.array(z.enum(PROCESSING_STATUSES)).min(1).optional(),
		processingStatuses: z.array(z.enum(PROCESSING_STATUSES)).min(1).optional(),
		receivedFrom: z.iso.date().optional(),
		receivedTo: z.iso.date().optional(),
		trashed: z.boolean().optional(),
		limit: z.number().int().min(1).max(200).optional(),
		cursor: z.string().min(1).optional(),
	})
	.refine(
		(input) =>
			input.receivedFrom === undefined ||
			input.receivedTo === undefined ||
			input.receivedFrom <= input.receivedTo,
		{ message: "receivedFrom must not be later than receivedTo" },
	);

const updateInputSchema = resourceSchema
	.extend({
		title: z.string().min(1).nullable().optional(),
		correspondent: z.string().min(1).max(200).nullable().optional(),
		type: z.enum(DOCUMENT_TYPES).nullable().optional(),
		receivedOn: z.iso.date().nullable().optional(),
		notes: z.string().max(10_000).nullable().optional(),
	})
	.refine(
		(input) =>
			input.title !== undefined ||
			input.correspondent !== undefined ||
			input.type !== undefined ||
			input.receivedOn !== undefined ||
			input.notes !== undefined,
		{ message: "At least one document field is required" },
	);

const moveInputSchema = z.object({
	ids: idsSchema,
	folderId: idSchema.nullable(),
});
const trashInputSchema = z.object({ ids: idsSchema });

const folderCreateSchema = z.object({
	name: z.string().min(1).max(200),
	parentId: idSchema.nullable().optional(),
});
const folderUpdateSchema = resourceSchema
	.extend({
		name: z.string().min(1).max(200).optional(),
		parentId: idSchema.nullable().optional(),
	})
	.refine((input) => input.name !== undefined || input.parentId !== undefined, {
		message: "At least one folder field is required",
	});

const tagCreateSchema = z.object({ name: z.string().min(1).max(100) });
const tagUpdateSchema = resourceSchema.extend({
	name: z.string().min(1).max(100),
});

const tagsSetSchema = resourceSchema.extend({ tagIds: tagIdsSchema });
const tagsChangeSchema = resourceSchema
	.extend({
		addTagIds: tagIdsSchema.min(1).optional(),
		removeTagIds: tagIdsSchema.min(1).optional(),
	})
	.refine(
		(input) =>
			input.addTagIds !== undefined || input.removeTagIds !== undefined,
		{ message: "Provide at least one tag to add or remove" },
	)
	.refine(
		(input) =>
			(input.addTagIds ?? []).every(
				(id) => !(input.removeTagIds ?? []).includes(id),
			),
		{ message: "The same tag cannot be added and removed" },
	);

const uploadInputSchema = z
	.object({
		filename: z
			.string()
			.trim()
			.min(1)
			.max(255)
			.regex(/^[^\x00-\x1f\x7f]+$/, "Filenames cannot contain control characters"),
		mime: z.enum(
			Object.keys(ALLOWED_UPLOAD_MIME_TYPES) as Array<
				keyof typeof ALLOWED_UPLOAD_MIME_TYPES
			>,
		),
		size: z
			.number()
			.int()
			.positive()
			.max(MAX_UPLOAD_BYTES, `Uploads are limited to ${MAX_UPLOAD_BYTES} bytes`),
		title: z.string().min(1).optional(),
		folderId: idSchema.nullable().optional(),
	})
	.refine(
		(input) => {
			const extension = input.filename.split(".").pop()?.toLowerCase();
			return (
				extension !== undefined &&
				(ALLOWED_UPLOAD_MIME_TYPES[input.mime] as readonly string[]).includes(
					extension,
				)
			);
		},
		{ message: "The filename's extension must match the declared mime type" },
	);

const fileInputSchema = resourceSchema.extend({
	variant: z.enum(["original", "preview"]).default("original"),
});

function unavailable() {
	return { error: BACKEND_NOT_CONFIGURED };
}

/**
 * The list projection the agent reads. It drops `ocrText`, which is whole-page
 * OCR and would swamp a result page; `document_read` returns it in full.
 */
function summarize(document: PublicDocumentSummary) {
	return {
		id: document.id,
		title: document.title,
		originalName: document.originalName,
		mimeType: document.mimeType,
		size: document.size,
		folder: document.folder?.path ?? null,
		tags: document.tags.map((tag) => tag.name),
		correspondent: document.correspondent,
		type: document.type,
		receivedOn: document.receivedOn,
		processingStatus: document.processingStatus,
		ocrStatus: document.ocrStatus,
		trashed: document.deletedAt !== null,
	};
}

export const documents: Capability[] = [
	{
		name: "document_search",
		description:
			"Find documents in the archive by words in their title, filename, or OCR text, or list them filtered by folder, tag, correspondent, type, status, or received date",
		inputSchema: listInputSchema,
		keywords: [
			"search documents",
			"find documents by name",
			"documents in this folder",
			"find the tax receipt",
			"documents from this company",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			const filters = input as z.infer<typeof listInputSchema>;
			const page =
				filters.query === undefined
					? await env.FILES.listDocuments(filters)
					: await env.FILES.searchDocuments({
							...filters,
							query: filters.query,
						});
			return {
				documents: page.documents.map(summarize),
				nextCursor: page.nextCursor,
			};
		},
	},
	{
		name: "document_read",
		description:
			"Open one document's full details: metadata, folder, tags, and complete OCR text",
		inputSchema: resourceSchema,
		keywords: [
			"read this document",
			"open document details",
			"document ocr text",
			"document metadata",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			const document = await env.FILES.getDocument(
				input as z.infer<typeof resourceSchema>,
			);
			return document ?? { error: NOT_FOUND };
		},
	},
	{
		name: "document_update",
		description:
			"Change a document's title, correspondent, type, received date, or notes; any field can be set to null to clear it",
		inputSchema: updateInputSchema,
		keywords: [
			"rename this document",
			"update document metadata",
			"set the correspondent",
			"edit document notes",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.updateDocument(
				input as z.infer<typeof updateInputSchema>,
			);
		},
	},
	{
		name: "document_move",
		description: "Move one or more documents into a folder, or out of all folders",
		inputSchema: moveInputSchema,
		keywords: [
			"move these documents",
			"file document in a folder",
			"put document in folder",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			const moved = await env.FILES.moveDocuments(
				input as z.infer<typeof moveInputSchema>,
			);
			return moved.map(summarize);
		},
	},
	{
		name: "document_trash",
		description: "Send one or more documents to the trash",
		inputSchema: trashInputSchema,
		keywords: [
			"delete this document",
			"trash these documents",
			"remove this document",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			const trashed = await env.FILES.trashDocuments(
				input as z.infer<typeof trashInputSchema>,
			);
			return trashed.map(summarize);
		},
	},
	{
		name: "document_restore",
		description: "Restore a trashed document",
		inputSchema: resourceSchema,
		keywords: [
			"restore this document",
			"undelete a document",
			"restore this document from the trash",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.restoreDocument(input as z.infer<typeof resourceSchema>);
		},
	},
	{
		name: "document_retry_processing",
		description: "Retry OCR or processing for a document that failed or got stuck",
		inputSchema: resourceSchema,
		keywords: [
			"retry document processing",
			"redo ocr",
			"document processing failed",
			"reprocess this file",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.retryDocumentProcessing(
				input as z.infer<typeof resourceSchema>,
			);
		},
	},
	{
		name: "document_correspondents",
		description:
			"List every sender or company that documents in the archive have come from",
		inputSchema: z.object({}),
		keywords: [
			"who sends me documents",
			"list document correspondents",
			"which companies are in my archive",
		],
		handler: async (_input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.listCorrespondents({});
		},
	},
	{
		name: "document_folders",
		description: "List the document folders and their paths",
		inputSchema: z.object({}),
		keywords: [
			"list document folders",
			"folder tree for documents",
			"document archive folders",
		],
		handler: async (_input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.listDocumentFolders({});
		},
	},
	{
		name: "document_folder_create",
		description: "Create a new document folder, optionally nested under a parent",
		inputSchema: folderCreateSchema,
		keywords: [
			"create a document folder",
			"new archive folder",
			"add a folder for documents",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.createDocumentFolder(
				input as z.infer<typeof folderCreateSchema>,
			);
		},
	},
	{
		name: "document_folder_update",
		description: "Rename a document folder or move it under a different parent",
		inputSchema: folderUpdateSchema,
		keywords: [
			"rename document folder",
			"change document folder parent",
			"change document folder name",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.updateDocumentFolder(
				input as z.infer<typeof folderUpdateSchema>,
			);
		},
	},
	{
		name: "document_folder_delete",
		description: "Delete a document folder",
		inputSchema: resourceSchema,
		keywords: ["delete document folder", "remove document folder"],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.deleteDocumentFolder(
				input as z.infer<typeof resourceSchema>,
			);
		},
	},
	{
		name: "document_tags",
		description: "List the document tag registry",
		inputSchema: z.object({}),
		keywords: [
			"list document tags",
			"which document tags exist",
			"document tag registry",
		],
		handler: async (_input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.listDocumentTags({});
		},
	},
	{
		name: "document_tag_create",
		description: "Create a new document tag",
		inputSchema: tagCreateSchema,
		keywords: ["create a document tag", "new document tag", "add a document tag"],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.createDocumentTag(
				input as z.infer<typeof tagCreateSchema>,
			);
		},
	},
	{
		name: "document_tag_update",
		description: "Rename a document tag",
		inputSchema: tagUpdateSchema,
		keywords: ["rename a document tag", "change document tag name"],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.updateDocumentTag(
				input as z.infer<typeof tagUpdateSchema>,
			);
		},
	},
	{
		name: "document_tag_delete",
		description:
			"Delete a document tag from the registry; documents keep their other tags",
		inputSchema: resourceSchema,
		keywords: ["delete a document tag", "remove document label"],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.deleteDocumentTag(
				input as z.infer<typeof resourceSchema>,
			);
		},
	},
	{
		name: "document_tags_set",
		description:
			"Replace all of a document's tags with exactly the tags given; an empty list removes them all",
		inputSchema: tagsSetSchema,
		keywords: [
			"replace the tags on this document",
			"make these the only tags on this document",
			"remove all tags from this document",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.updateDocumentTags(input as z.infer<typeof tagsSetSchema>);
		},
	},
	{
		name: "document_tags_update",
		description:
			"Add and remove tags on one document without changing its other tags",
		inputSchema: tagsChangeSchema,
		keywords: [
			"tag this document",
			"add a tag to this document",
			"untag this document",
			"change this document's tags",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			return env.FILES.changeDocumentTags(
				input as z.infer<typeof tagsChangeSchema>,
			);
		},
	},
	{
		name: "document_upload",
		description:
			"Prepare a five-minute, single-use link for uploading one local PDF or image file",
		inputSchema: uploadInputSchema,
		keywords: [
			"upload a document",
			"upload a local file",
			"scan this pdf into the archive",
			"add this file to documents",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			const upload = input as z.infer<typeof uploadInputSchema>;
			const { token, expiresAt } = await createTicket(env, "upload", upload);
			return {
				uploadUrl: documentUploadUrl(env, token),
				method: "PUT",
				headers: { "Content-Type": upload.mime },
				maxSizeBytes: MAX_UPLOAD_BYTES,
				expiresAt,
				instructions:
					"PUT the raw file bytes as the request body, with a Content-Type header matching mime and a Content-Length header matching size. Do not send the OAuth bearer token to this URL - it is a separate, single-use link, and one request spends it.",
			};
		},
	},
	{
		name: "document_file",
		description:
			"Prepare a five-minute, single-use link for downloading one document's original file, or its preview image",
		inputSchema: fileInputSchema,
		keywords: [
			"download this document",
			"get the file for this document",
			"download the original pdf",
			"show a preview of this document",
		],
		handler: async (input, { env }) => {
			if (!env.FILES) return unavailable();
			const { id, variant } = input as z.infer<typeof fileInputSchema>;
			const document = await env.FILES.getDocument({ id });
			if (document === null) return { error: NOT_FOUND };
			const { token, expiresAt } = await createTicket(env, "download", {
				id,
				variant,
			});
			return {
				downloadUrl: documentFileUrl(env, token),
				variant,
				filename: document.originalName,
				mimeType: variant === "preview" ? null : document.mimeType,
				size: variant === "preview" ? null : document.size,
				previewKind: document.preview.kind,
				expiresAt,
			};
		},
	},
];
