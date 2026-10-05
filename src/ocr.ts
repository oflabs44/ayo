import { consumeTicket } from "./documents/tickets";
import type { Env } from "./env";

// The `ocr` Worker's error messages start with one of these codes. A failure
// with no known code is answered as ocr_failed with a generic message.
const STATUS_BY_OCR_ERROR_CODE: Record<string, number> = {
	not_a_pdf: 415,
	too_large: 413,
	unsupported_language: 400,
	timeout: 504,
	ocr_failed: 502,
};

export function ocrExtractUrl(env: Env, token: string): string {
	return `${env.PUBLIC_BASE_URL}/ocr/extract/${token}`;
}

/**
 * Streams the request body straight to the `ocr` Worker - it is never
 * buffered or stored here. That Worker enforces the PDF check, the size
 * limit, and the time limit.
 */
export async function handleOcrExtract(
	request: Request,
	env: Env,
	token: string,
): Promise<Response> {
	if (!env.OCR) {
		return new Response("The OCR backend is not configured.", { status: 503 });
	}

	const payload = await consumeTicket(env, "ocr", token);
	if (payload === null) {
		return new Response("This link is invalid, expired, or already used.", {
			status: 410,
		});
	}
	if (request.body === null) {
		return new Response(
			"A PDF body is required. This link is now spent; request a new one.",
			{ status: 400 },
		);
	}

	try {
		const { text, pages } = await env.OCR.extract(request.body, {
			languages: payload.languages,
		});
		return Response.json({ text, pages });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = message.split(":", 1)[0]!;
		if (!Object.hasOwn(STATUS_BY_OCR_ERROR_CODE, code)) {
			console.error("ayo ocr extract failed", error);
			return Response.json(
				{ error: "ocr_failed", message: "The PDF could not be read." },
				{ status: 502 },
			);
		}
		const status = STATUS_BY_OCR_ERROR_CODE[code]!;
		if (status >= 500) console.error("ayo ocr extract failed", error);
		return Response.json({ error: code, message }, { status });
	}
}
