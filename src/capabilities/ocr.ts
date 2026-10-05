import { z } from "zod";
import { createTicket } from "../documents/tickets";
import { ocrExtractUrl } from "../ocr";
import type { Capability } from "./index";

// The `ocr` Worker's own limits, repeated here so the caller learns them
// before it sends a file. Keep in sync with MAX_PDF_BYTES and
// SUPPORTED_LANGUAGES in oflabs44/ocr src/index.ts.
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const OCR_LANGUAGES = ["deu", "eng"] as const;

const extractInputSchema = z.object({
	languages: z.array(z.enum(OCR_LANGUAGES)).min(1).optional(),
});

export const ocr: Capability[] = [
	{
		name: "ocr_extract",
		description:
			"Read the text out of a scanned or photographed PDF without saving it: prepare a five-minute, single-use link that takes one local PDF and answers with its text",
		inputSchema: extractInputSchema,
		keywords: [
			"ocr this pdf",
			"extract text from a scan",
			"text recognition",
			"what does this scanned letter say",
			"convert a scanned pdf to text",
		],
		handler: async (input, { env }) => {
			if (!env.OCR) return { error: "The OCR backend is not configured." };
			const { languages } = input as z.infer<typeof extractInputSchema>;
			const { token, expiresAt } = await createTicket(env, "ocr", {
				languages,
			});
			return {
				extractUrl: ocrExtractUrl(env, token),
				method: "POST",
				headers: { "Content-Type": "application/pdf" },
				maxSizeBytes: MAX_PDF_BYTES,
				expiresAt,
				instructions:
					"POST the raw PDF bytes as the request body. The response is JSON { text, pages }; pages in text are separated by a form feed (\\f). OCR can take more than five minutes on a large scan, so allow a timeout of at least seven minutes. A failure answers with JSON { error, message } and also spends the link. Do not send the OAuth bearer token to this URL - it is a separate, single-use link, and one request spends it.",
			};
		},
	},
];
