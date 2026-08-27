import type { ExecutionContext } from "cloudflare:workers";
import type { Env } from "./env";
import { runTriggeredJobs } from "./jobs/runner";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_TIMESTAMP_AGE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

type WebhookSource = {
	verification: "hmac";
	signatureHeader: string;
	timestampHeader: string;
	secretBinding: string;
	enabled: boolean;
};

export type WebhookEvent = Record<string, unknown> & {
	id: string;
	kind?: string;
};

type TriggerDispatcher = (
	env: Env,
	ctx: ExecutionContext,
	source: string,
	event: WebhookEvent,
) => Promise<void>;

function notFound(): Response {
	return new Response(null, { status: 404 });
}

function parseSource(value: string | null): WebhookSource | null {
	if (value === null) return null;
	try {
		const source = JSON.parse(value) as Record<string, unknown>;
		const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
		if (
			source.verification !== "hmac" ||
			typeof source.signatureHeader !== "string" ||
			!headerName.test(source.signatureHeader) ||
			typeof source.timestampHeader !== "string" ||
			!headerName.test(source.timestampHeader) ||
			typeof source.secretBinding !== "string" ||
			!/^WEBHOOK_SECRET_[A-Z0-9_]+$/.test(source.secretBinding) ||
			typeof source.enabled !== "boolean"
		) {
			return null;
		}
		return source as WebhookSource;
	} catch {
		return null;
	}
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
	if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) return null;
	const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function verifySignature(input: {
	secret: string;
	timestamp: string;
	body: Uint8Array<ArrayBuffer>;
	signature: string;
}): Promise<boolean> {
	if (!input.signature.startsWith("sha256=")) return false;
	const signature = fromHex(input.signature.slice("sha256=".length));
	if (signature === null) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(input.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const prefix = encoder.encode(`${input.timestamp}.`);
	const signed = new Uint8Array(prefix.length + input.body.length);
	signed.set(prefix);
	signed.set(input.body, prefix.length);
	return crypto.subtle.verify("HMAC", key, signature, signed);
}

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null && Number(contentLength) > MAX_PAYLOAD_BYTES) {
		return null;
	}
	if (request.body === null) return new Uint8Array(new ArrayBuffer(0));

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.length;
		if (length > MAX_PAYLOAD_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}

	const body = new Uint8Array(new ArrayBuffer(length));
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}
	return body;
}

function parseEvent(body: Uint8Array<ArrayBuffer>): WebhookEvent {
	const event = JSON.parse(new TextDecoder().decode(body)) as Record<
		string,
		unknown
	>;
	if (
		event === null ||
		Array.isArray(event) ||
		typeof event !== "object" ||
		typeof event.id !== "string" ||
		event.id.length === 0 ||
		(event.kind !== undefined && typeof event.kind !== "string")
	) {
		throw new Error("Webhook event must be an object with a non-empty id.");
	}
	return event as WebhookEvent;
}

export async function handleHook(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	sourceName: string,
	dispatch: TriggerDispatcher = runTriggeredJobs,
): Promise<Response> {
	const source = parseSource(
		await env.OAUTH_KV.get(`webhook-source:${sourceName}`),
	);
	if (source === null || !source.enabled) return notFound();

	const signature = request.headers.get(source.signatureHeader);
	const secret = env[source.secretBinding];
	if (signature === null || typeof secret !== "string" || secret.length === 0) {
		return notFound();
	}

	const timestamp = request.headers.get(source.timestampHeader);
	if (timestamp === null || !/^\d+$/.test(timestamp)) return notFound();
	const seconds = Number(timestamp);
	if (
		!Number.isSafeInteger(seconds) ||
		Math.abs(Math.floor(Date.now() / 1_000) - seconds) >
			MAX_TIMESTAMP_AGE_SECONDS
	) {
		return notFound();
	}

	const body = await readBody(request);
	if (body === null) return new Response(null, { status: 413 });
	if (!(await verifySignature({ secret, timestamp, body, signature }))) {
		return notFound();
	}

	// The Cloudflare WAF must rate-limit this public route before it reaches the Worker.
	try {
		const event = parseEvent(body);
		await dispatch(env, ctx, sourceName, event);
		return new Response(null, { status: 202 });
	} catch (error) {
		console.error("ayo accepted webhook could not be dispatched", error);
		return new Response(null, { status: 500 });
	}
}
