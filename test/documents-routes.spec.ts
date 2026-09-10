import { env as bindings } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
	handleDocumentFile,
	handleDocumentUpload,
} from "../src/documents/routes";
import {
	consumeTicket,
	createTicket,
	pruneExpiredTickets,
} from "../src/documents/tickets";
import type { Env, FilesBinding, PublicDocument } from "../src/env";

function createHarness(files: Partial<FilesBinding> = {}) {
	return {
		JOBS_DB: bindings.JOBS_DB,
		FILES: files as FilesBinding,
	} as unknown as Env;
}

const uploadedDocument = { id: "doc-1", title: "receipt.pdf" } as PublicDocument;
const uploadTicket = {
	filename: "a.pdf",
	mime: "application/pdf",
	size: 1,
};
const downloadTicket = { id: "doc-1", variant: "original" as const };

describe("document tickets", () => {
	it("round-trips a ticket exactly once", async () => {
		const env = createHarness();
		const { token } = await createTicket(env, "upload", uploadTicket);

		await expect(consumeTicket(env, "upload", token)).resolves.toEqual(uploadTicket);
		await expect(consumeTicket(env, "upload", token)).resolves.toBeNull();
	});

	it("gives the payload to exactly one of two concurrent consumers", async () => {
		const env = createHarness();
		const { token } = await createTicket(env, "download", downloadTicket);

		const results = await Promise.all([
			consumeTicket(env, "download", token),
			consumeTicket(env, "download", token),
		]);

		expect(results.filter((result) => result !== null)).toEqual([downloadTicket]);
	});

	it("rejects an unknown token or the wrong kind", async () => {
		const env = createHarness();
		const { token } = await createTicket(env, "upload", uploadTicket);

		await expect(consumeTicket(env, "download", token)).resolves.toBeNull();
		await expect(consumeTicket(env, "upload", "not-a-token")).resolves.toBeNull();
	});

	it("mints an opaque token that is never stored in the clear", async () => {
		const env = createHarness();
		const { token } = await createTicket(env, "upload", uploadTicket);

		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const stored = await bindings.JOBS_DB.prepare(
			"SELECT token_hash FROM document_tickets",
		).all<{ token_hash: string }>();
		expect(stored.results.some((row) => row.token_hash === token)).toBe(false);
	});

	it("prunes only tickets that have already expired", async () => {
		const env = createHarness();
		const { token } = await createTicket(env, "upload", uploadTicket);

		await pruneExpiredTickets(env, Date.now());
		await expect(consumeTicket(env, "upload", token)).resolves.toEqual(uploadTicket);

		const { token: later } = await createTicket(env, "upload", {
			...uploadTicket,
			filename: "later.pdf",
		});
		await pruneExpiredTickets(env, Date.now() + 10 * 60_000);
		await expect(consumeTicket(env, "upload", later)).resolves.toBeNull();
	});
});

describe("document upload route", () => {
	it("streams the request body straight to FILES.uploadDocument", async () => {
		const uploadDocument = vi.fn(async (_metadata, body: ReadableStream) => {
			const reader = body.getReader();
			for (let read = await reader.read(); !read.done; read = await reader.read());
			return { status: "created" as const, document: uploadedDocument };
		});
		const env = createHarness({ uploadDocument });
		const { token } = await createTicket(env, "upload", {
			filename: "receipt.pdf",
			mime: "application/pdf",
			size: 4,
		});
		const request = new Request(`https://ayo.example/documents/upload/${token}`, {
			method: "PUT",
			headers: { "Content-Type": "application/pdf", "Content-Length": "4" },
			body: new Uint8Array([1, 2, 3, 4]),
		});

		const response = await handleDocumentUpload(request, env, token);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({
			status: "created",
			documentId: "doc-1",
			title: "receipt.pdf",
		});
		expect(uploadDocument).toHaveBeenCalledWith(
			{
				filename: "receipt.pdf",
				mime: "application/pdf",
				size: 4,
				title: undefined,
				folderId: undefined,
			},
			expect.anything(),
		);
	});

	it("answers 200 when the backend recognised the file already", async () => {
		const env = createHarness({
			uploadDocument: vi.fn(async () => ({
				status: "existing" as const,
				document: uploadedDocument,
			})),
		});
		const { token } = await createTicket(env, "upload", {
			filename: "receipt.pdf",
			mime: "application/pdf",
			size: 4,
		});

		const response = await handleDocumentUpload(
			new Request(`https://ayo.example/documents/upload/${token}`, {
				method: "PUT",
				headers: { "Content-Type": "application/pdf", "Content-Length": "4" },
				body: new Uint8Array([1, 2, 3, 4]),
			}),
			env,
			token,
		);

		expect(response.status).toBe(200);
	});

	it("refuses a Content-Type or Content-Length that does not match the ticket", async () => {
		const env = createHarness();
		const { token } = await createTicket(env, "upload", {
			filename: "receipt.pdf",
			mime: "application/pdf",
			size: 4,
		});

		const response = await handleDocumentUpload(
			new Request(`https://ayo.example/documents/upload/${token}`, {
				method: "PUT",
				headers: { "Content-Type": "image/png", "Content-Length": "4" },
				body: new Uint8Array([1, 2, 3, 4]),
			}),
			env,
			token,
		);

		expect(response.status).toBe(400);
		// The mismatch spends the link rather than leaving it open to probing.
		await expect(consumeTicket(env, "upload", token)).resolves.toBeNull();
	});

	it("reports a backend failure as 502", async () => {
		const env = createHarness({
			uploadDocument: vi.fn(async () => {
				throw new Error("bureau-files is down");
			}),
		});
		const { token } = await createTicket(env, "upload", {
			filename: "receipt.pdf",
			mime: "application/pdf",
			size: 4,
		});

		const response = await handleDocumentUpload(
			new Request(`https://ayo.example/documents/upload/${token}`, {
				method: "PUT",
				headers: { "Content-Type": "application/pdf", "Content-Length": "4" },
				body: new Uint8Array([1, 2, 3, 4]),
			}),
			env,
			token,
		);

		expect(response.status).toBe(502);
	});

	it("returns 410 for an invalid, expired, or already-used ticket", async () => {
		const env = createHarness();
		const response = await handleDocumentUpload(
			new Request("https://ayo.example/documents/upload/bogus", { method: "PUT" }),
			env,
			"bogus",
		);
		expect(response.status).toBe(410);
	});

	it("reports the missing backend as 503 without spending the ticket", async () => {
		const env = createHarness();
		const { token } = await createTicket(env, "upload", {
			filename: "receipt.pdf",
			mime: "application/pdf",
			size: 4,
		});
		delete (env as { FILES?: unknown }).FILES;

		const response = await handleDocumentUpload(
			new Request(`https://ayo.example/documents/upload/${token}`, {
				method: "PUT",
			}),
			env,
			token,
		);

		expect(response.status).toBe(503);
	});
});

describe("document file route", () => {
	it("streams FILES.getDocumentFile's response straight through", async () => {
		const fileResponse = new Response("file bytes");
		const getDocumentFile = vi.fn(async () => fileResponse);
		const env = createHarness({ getDocumentFile });
		const { token } = await createTicket(env, "download", {
			id: "doc-1",
			variant: "original",
		});

		const response = await handleDocumentFile(env, token);

		expect(response).toBe(fileResponse);
		expect(getDocumentFile).toHaveBeenCalledWith({ id: "doc-1" });
	});

	it("streams the preview when the ticket asked for one", async () => {
		const previewResponse = new Response("preview bytes");
		const getDocumentPreview = vi.fn(async () => previewResponse);
		const getDocumentFile = vi.fn();
		const env = createHarness({ getDocumentPreview, getDocumentFile });
		const { token } = await createTicket(env, "download", {
			id: "doc-1",
			variant: "preview",
		});

		const response = await handleDocumentFile(env, token);

		expect(response).toBe(previewResponse);
		expect(getDocumentPreview).toHaveBeenCalledWith({ id: "doc-1" });
		expect(getDocumentFile).not.toHaveBeenCalled();
	});

	it("returns 410 for an invalid, expired, or already-used ticket", async () => {
		const env = createHarness();
		const response = await handleDocumentFile(env, "bogus");
		expect(response.status).toBe(410);
	});

	it("reports the missing backend as 503 without spending the ticket", async () => {
		const env = createHarness();
		const { token } = await createTicket(env, "download", downloadTicket);
		delete (env as { FILES?: unknown }).FILES;

		const response = await handleDocumentFile(env, token);

		expect(response.status).toBe(503);
		await expect(consumeTicket(env, "download", token)).resolves.toEqual(downloadTicket);
	});
});
