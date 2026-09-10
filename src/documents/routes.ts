import type { Env } from "../env";
import { consumeTicket } from "./tickets";

function gone(): Response {
	return new Response("This link is invalid, expired, or already used.", {
		status: 410,
	});
}

function unavailable(): Response {
	return new Response("The documents backend is not configured.", {
		status: 503,
	});
}

function badRequest(message: string): Response {
	return new Response(`${message} This link is now spent; request a new one.`, {
		status: 400,
	});
}

/**
 * Streams the request body straight to FILES.uploadDocument - it is never
 * buffered here. The ticket's declared filename, mime, and size come from
 * document_upload, not from this request, so a forged Content-Type or
 * Content-Length can only be rejected, never substituted.
 *
 * The ticket is consumed before the headers are checked, so a mismatch spends
 * the link rather than leaving it open to repeated probing.
 */
export async function handleDocumentUpload(
	request: Request,
	env: Env,
	token: string,
): Promise<Response> {
	if (!env.FILES) return unavailable();

	const payload = await consumeTicket(env, "upload", token);
	if (payload === null) return gone();

	if (request.headers.get("content-type") !== payload.mime) {
		return badRequest(`Content-Type must be ${payload.mime}.`);
	}
	const contentLength = request.headers.get("content-length");
	if (contentLength === null || Number(contentLength) !== payload.size) {
		return badRequest(`Content-Length must be ${payload.size}.`);
	}
	if (request.body === null) return badRequest("A file body is required.");

	try {
		const { status, document } = await env.FILES.uploadDocument(
			{
				filename: payload.filename,
				mime: payload.mime,
				size: payload.size,
				title: payload.title,
				folderId: payload.folderId,
			},
			request.body,
		);
		return Response.json(
			{ status, documentId: document.id, title: document.title },
			{ status: status === "created" ? 201 : 200 },
		);
	} catch (error) {
		console.error("ayo document upload failed", error);
		return new Response("The upload could not be stored.", { status: 502 });
	}
}

export async function handleDocumentFile(
	env: Env,
	token: string,
): Promise<Response> {
	if (!env.FILES) return unavailable();

	const payload = await consumeTicket(env, "download", token);
	if (payload === null) return gone();

	try {
		return payload.variant === "preview"
			? await env.FILES.getDocumentPreview({ id: payload.id })
			: await env.FILES.getDocumentFile({ id: payload.id });
	} catch (error) {
		console.error("ayo document download failed", error);
		return new Response("The file could not be read.", { status: 502 });
	}
}
