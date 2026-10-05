import { env as bindings } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ocr } from "../src/capabilities/ocr";
import { consumeTicket, createTicket } from "../src/documents/tickets";
import type { Env, OcrBinding, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";
import { handleOcrExtract } from "../src/ocr";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

function createHarness(extract: OcrBinding["extract"]) {
	return {
		JOBS_DB: bindings.JOBS_DB,
		PUBLIC_BASE_URL: "https://ayo.oflabs.dev",
		OCR: { extract },
	} as unknown as Env;
}

function pdfRequest(token: string): Request {
	return new Request(`https://ayo.example/ocr/extract/${token}`, {
		method: "POST",
		body: new Uint8Array([1, 2, 3, 4]),
	});
}

describe("ocr_extract", () => {
	it("mints a link whose ticket carries the requested languages", async () => {
		const env = createHarness(vi.fn());
		const dispatch = buildDispatchTable(ocr, env, props);

		const result = (await dispatch.ocr_extract!({ languages: ["deu"] })) as {
			extractUrl: string;
		};

		const match = /^https:\/\/ayo\.oflabs\.dev\/ocr\/extract\/([A-Za-z0-9_-]{43})$/.exec(
			result.extractUrl,
		);
		expect(match).not.toBeNull();
		await expect(consumeTicket(env, "ocr", match![1]!)).resolves.toEqual({
			languages: ["deu"],
		});
	});

	it("refuses a language the OCR image does not have", async () => {
		const dispatch = buildDispatchTable(ocr, createHarness(vi.fn()), props);

		await expect(dispatch.ocr_extract!({ languages: ["fra"] })).rejects.toThrow();
	});
});

describe("ocr extract route", () => {
	it("streams the body to the OCR backend and answers with its text", async () => {
		const extract = vi.fn(async (pdf: ReadableStream<Uint8Array> | Uint8Array) => {
			const received = new Uint8Array(await new Response(pdf).arrayBuffer());
			return { text: `read ${received.byteLength} bytes`, pages: 1 };
		});
		const env = createHarness(extract);
		const { token } = await createTicket(env, "ocr", { languages: ["eng"] });

		const response = await handleOcrExtract(pdfRequest(token), env, token);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			text: "read 4 bytes",
			pages: 1,
		});
		expect(extract).toHaveBeenCalledWith(expect.anything(), {
			languages: ["eng"],
		});
	});

	it("spends the ticket on the first request", async () => {
		const env = createHarness(vi.fn(async () => ({ text: "", pages: 0 })));
		const { token } = await createTicket(env, "ocr", {});

		const first = await handleOcrExtract(pdfRequest(token), env, token);
		const second = await handleOcrExtract(pdfRequest(token), env, token);

		expect(first.status).toBe(200);
		expect(second.status).toBe(410);
	});

	it("maps the OCR backend's coded errors to their HTTP status", async () => {
		const env = createHarness(
			vi.fn(async () => {
				throw new Error("not_a_pdf: the file does not start with %PDF");
			}),
		);
		const { token } = await createTicket(env, "ocr", {});

		const response = await handleOcrExtract(pdfRequest(token), env, token);

		expect(response.status).toBe(415);
		await expect(response.json()).resolves.toMatchObject({ error: "not_a_pdf" });
	});

	it("reports any other backend failure as a generic 502 without its detail", async () => {
		const env = createHarness(
			vi.fn(async () => {
				throw new Error("ocr_failed: ocrmypdf failed: /tmp/work/in.pdf");
			}),
		);
		const { token } = await createTicket(env, "ocr", {});

		const response = await handleOcrExtract(pdfRequest(token), env, token);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			error: "ocr_failed",
			message: "The file could not be read.",
		});
	});
});
