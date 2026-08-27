import { env as bindings } from "cloudflare:workers";
import type { ExecutionContext } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleHook, type WebhookEvent } from "../src/hooks";

const secret = "bureau-webhook-secret";
const encoder = new TextEncoder();

function createHarness() {
	const env = {
		OAUTH_KV: bindings.OAUTH_KV,
		WEBHOOK_SECRET_BUREAU: secret,
	} as unknown as Env;
	const waits: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => waits.push(promise),
	} as unknown as ExecutionContext;
	return { env, ctx, waits };
}

async function configure(
	env: Env,
	name: string,
	options: {
		enabled?: boolean;
		secretBinding?: string;
		timestampHeader?: string | null;
	} = {},
) {
	await env.OAUTH_KV.put(
		`webhook-source:${name}`,
		JSON.stringify({
			verification: "hmac",
			signatureHeader: "x-bureau-signature",
			...(options.timestampHeader === null
				? {}
				: {
						timestampHeader:
							options.timestampHeader ?? "x-bureau-timestamp",
					}),
			secretBinding: options.secretBinding ?? "WEBHOOK_SECRET_BUREAU",
			enabled: options.enabled ?? true,
		}),
	);
}

async function sign(timestamp: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(`${timestamp}.${body}`),
		),
	);
	return `sha256=${Array.from(signature, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

async function request(
	body: string,
	timestamp: string,
	signature?: string,
): Promise<Request> {
	return new Request("https://ayo.example/hooks/bureau", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-bureau-signature": signature ?? (await sign(timestamp, body)),
			"x-bureau-timestamp": timestamp,
		},
		body,
	});
}

async function responseShape(response: Response) {
	return {
		status: response.status,
		statusText: response.statusText,
		contentType: response.headers.get("content-type"),
		body: await response.text(),
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("webhook ingress", () => {
	it("accepts a valid Bureau signature after durable dispatch", async () => {
		const now = Date.parse("2026-08-20T10:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx, waits } = createHarness();
		await configure(env, "bureau");
		const event = {
			id: "event-1",
			kind: "mail.received",
			data: { id: "message-1" },
		};
		const body = JSON.stringify(event);
		const timestamp = String(Math.floor(now / 1_000));
		const dispatch = vi.fn(
			async (
				_env: Env,
				_ctx: ExecutionContext,
				_source: string,
				_event: WebhookEvent,
			) => undefined,
		);

		const response = await handleHook(
			await request(body, timestamp),
			env,
			ctx,
			"bureau",
			dispatch,
		);

		expect(response.status).toBe(202);
		await Promise.all(waits);
		expect(dispatch).toHaveBeenCalledWith(env, ctx, "bureau", event);
	});

	it("does not acknowledge before dispatch claims complete", async () => {
		const { env, ctx } = createHarness();
		await configure(env, "bureau");
		const timestamp = String(Math.floor(Date.now() / 1_000));
		const body = JSON.stringify({ id: "event-claim", kind: "mail.received" });
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const dispatch = vi.fn(async () => blocked);
		let settled = false;

		const responsePromise = handleHook(
			await request(body, timestamp),
			env,
			ctx,
			"bureau",
			dispatch,
		).then((response) => {
			settled = true;
			return response;
		});
		await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
		expect(settled).toBe(false);

		release();
		await expect(responsePromise).resolves.toMatchObject({ status: 202 });
	});

	it("returns 500 when durable dispatch fails", async () => {
		const { env, ctx } = createHarness();
		await configure(env, "bureau");
		const timestamp = String(Math.floor(Date.now() / 1_000));
		const body = JSON.stringify({ id: "event-failed", kind: "mail.received" });
		const error = new Error("D1 claim failed");
		const dispatch = vi.fn(async () => {
			throw error;
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const response = await handleHook(
			await request(body, timestamp),
			env,
			ctx,
			"bureau",
			dispatch,
		);

		expect(response.status).toBe(500);
		expect(consoleError).toHaveBeenCalledWith(
			"ayo accepted webhook could not be dispatched",
			error,
		);
	});

	it("returns the same bare 404 and never dispatches for verification failures", async () => {
		const now = Date.parse("2026-08-20T10:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { env, ctx } = createHarness();
		await configure(env, "bureau");
		await configure(env, "disabled", { enabled: false });
		await configure(env, "missing-timestamp", { timestampHeader: null });
		await configure(env, "invalid-binding", {
			secretBinding: "ACCESS_OIDC_CLIENT_SECRET",
		});
		const timestamp = String(Math.floor(now / 1_000));
		const staleTimestamp = String(Math.floor(now / 1_000) - 301);
		const body = JSON.stringify({ id: "event-1", kind: "mail.received" });
		const dispatch = vi.fn(async () => undefined);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const validSignature = await sign(timestamp, body);
		const failures = [
			await handleHook(
				await request(`${body} `, timestamp, validSignature),
				env,
				ctx,
				"bureau",
				dispatch,
			),
			await handleHook(
				await request(body, staleTimestamp),
				env,
				ctx,
				"bureau",
				dispatch,
			),
			await handleHook(
				await request(body, timestamp),
				env,
				ctx,
				"unknown",
				dispatch,
			),
			await handleHook(
				await request(body, timestamp),
				env,
				ctx,
				"disabled",
				dispatch,
			),
			await handleHook(
				await request(body, timestamp),
				env,
				ctx,
				"missing-timestamp",
				dispatch,
			),
			await handleHook(
				await request(body, timestamp),
				env,
				ctx,
				"invalid-binding",
				dispatch,
			),
		];
		const shapes = await Promise.all(failures.map(responseShape));

		expect(shapes).toEqual(Array(6).fill(shapes[0]));
		expect(shapes[0]).toEqual({
			status: 404,
			statusText: "Not Found",
			contentType: null,
			body: "",
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("rejects a payload larger than 1 MB", async () => {
		const { env, ctx } = createHarness();
		await configure(env, "bureau");
		const timestamp = String(Math.floor(Date.now() / 1_000));
		const body = "x".repeat(1024 * 1024 + 1);

		const response = await handleHook(
			await request(body, timestamp),
			env,
			ctx,
			"bureau",
		);

		expect(response.status).toBe(413);
	});
});
