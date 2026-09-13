import { afterEach, describe, expect, it, vi } from "vitest";
import { migadu } from "../src/capabilities/migadu";
import type { Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

const user = "oladayo@example.com";
const apiKey = "migadu-secret-that-must-not-leak";

type Reply = { status?: number; body: unknown };
type SentRequest = {
	url: string;
	method: string;
	headers: Headers;
	body: unknown;
};

function createHarness(replies: Reply[]) {
	const sent: SentRequest[] = [];
	const queue = [...replies];
	const migaduFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const rawBody = typeof init?.body === "string" ? init.body : undefined;
		sent.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: rawBody === undefined ? undefined : JSON.parse(rawBody),
		});
		const next = queue.shift() ?? {
			status: 500,
			body: { message: "No response queued" },
		};
		return new Response(
			next.body === undefined ? "" : JSON.stringify(next.body),
			{
				status: next.status ?? 200,
				headers: { "content-type": "application/json" },
			},
		);
	});
	const env = {
		MIGADU_USER: user,
		MIGADU_API_KEY: apiKey,
		MIGADU_FETCH_FOR_TESTS: migaduFetch as typeof fetch,
	} as unknown as Env;
	return {
		sent,
		migaduFetch,
		dispatch: buildDispatchTable(migadu, env, props),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("migadu_domains", () => {
	it("sends basic auth and projects the domain list", async () => {
		const { sent, dispatch } = createHarness([
			{
				body: {
					domains: [{ name: "example.com", state: "active", description: "" }],
				},
			},
		]);

		const result = await dispatch.migadu_domains!({});

		expect(result).toEqual({
			domains: [{ name: "example.com", state: "active", description: "" }],
		});
		expect(sent[0]?.url).toBe("https://api.migadu.com/v1/domains");
		expect(sent[0]?.headers.get("authorization")).toBe(
			`Basic ${btoa(`${user}:${apiKey}`)}`,
		);
	});
});

describe("migadu_domain_create", () => {
	it("always sends hosted_dns false and defaults create_default_addresses to true", async () => {
		const { sent, dispatch } = createHarness([
			{ body: { name: "example.com", state: "inactive", description: "" } },
		]);

		const result = await dispatch.migadu_domain_create!({ name: "Example.com" });

		expect(sent[0]?.method).toBe("POST");
		expect(sent[0]?.url).toBe("https://api.migadu.com/v1/domains");
		expect(sent[0]?.body).toEqual({
			name: "example.com",
			create_default_addresses: true,
			hosted_dns: false,
		});
		expect(result).toEqual({
			name: "example.com",
			state: "inactive",
			description: "",
		});
	});

	it("rejects a domain name with a slash before any fetch", async () => {
		const { migaduFetch, dispatch } = createHarness([]);

		await expect(
			dispatch.migadu_domain_create!({ name: "example.com/evil" }),
		).rejects.toThrow();
		expect(migaduFetch).not.toHaveBeenCalled();
	});
});

describe("migadu_domain_records", () => {
	it("gets the records for a domain", async () => {
		const { sent, dispatch } = createHarness([
			{
				body: {
					domain_name: "example.com",
					mx_records: [
						{ name: "@", type: "mx", value: "aspmx1.migadu.com", priority: 10 },
					],
				},
			},
		]);

		const result = await dispatch.migadu_domain_records!({ domain: "example.com" });

		expect(sent[0]?.url).toBe(
			"https://api.migadu.com/v1/domains/example.com/records",
		);
		expect(result).toMatchObject({ domain_name: "example.com" });
	});
});

describe("migadu_domain_activate", () => {
	it("surfaces Migadu's message on a 422 DNS-not-ready response", async () => {
		const { dispatch } = createHarness([
			{
				status: 422,
				body: {
					error: "dns_check_failed",
					message: "DNS checks failed, please check your DNS and try activating domain.",
				},
			},
		]);

		await expect(
			dispatch.migadu_domain_activate!({ domain: "example.com" }),
		).rejects.toThrow("DNS checks failed");
	});

	it("projects the activated domain on success", async () => {
		const { dispatch } = createHarness([
			{ body: { name: "example.com", state: "active" } },
		]);

		await expect(
			dispatch.migadu_domain_activate!({ domain: "example.com" }),
		).resolves.toEqual({ name: "example.com", state: "active", description: null });
	});
});

describe("migadu_mailbox_create", () => {
	it("always uses invitation password method and never accepts a password", async () => {
		const { sent, dispatch } = createHarness([
			{
				body: {
					address: "billing@example.com",
					name: "Billing",
					password_method: "invitation",
				},
			},
		]);

		const result = await dispatch.migadu_mailbox_create!({
			domain: "example.com",
			local_part: "billing",
			name: "Billing",
			password_recovery_email: "oladayo@example.com",
		});

		expect(sent[0]?.method).toBe("POST");
		expect(sent[0]?.url).toBe(
			"https://api.migadu.com/v1/domains/example.com/mailboxes",
		);
		expect(sent[0]?.body).toEqual({
			local_part: "billing",
			name: "Billing",
			password_recovery_email: "oladayo@example.com",
			password_method: "invitation",
		});
		expect(sent[0]?.body).not.toHaveProperty("password");
		expect(result).toEqual({ address: "billing@example.com", name: "Billing" });
	});
});

describe("migadu_alias_create and migadu_alias_delete", () => {
	it("creates an alias with destinations and optional is_internal", async () => {
		const { sent, dispatch } = createHarness([
			{
				body: {
					address: "sales@example.com",
					destinations: ["oladayo@example.com"],
				},
			},
		]);

		const result = await dispatch.migadu_alias_create!({
			domain: "example.com",
			local_part: "sales",
			destinations: ["oladayo@example.com"],
			is_internal: true,
		});

		expect(sent[0]?.body).toEqual({
			local_part: "sales",
			destinations: ["oladayo@example.com"],
			is_internal: true,
		});
		expect(result).toEqual({
			address: "sales@example.com",
			destinations: ["oladayo@example.com"],
		});
	});

	it("deletes an alias by domain and local part", async () => {
		const { sent, dispatch } = createHarness([{ body: undefined }]);

		const result = await dispatch.migadu_alias_delete!({
			domain: "example.com",
			local_part: "sales",
		});

		expect(sent[0]?.method).toBe("DELETE");
		expect(sent[0]?.url).toBe(
			"https://api.migadu.com/v1/domains/example.com/aliases/sales",
		);
		expect(result).toEqual({ deleted: true, address: "sales@example.com" });
	});
});

describe("Migadu failures", () => {
	it("reports missing secrets before fetch", async () => {
		const migaduFetch = vi.fn();
		const dispatch = buildDispatchTable(
			migadu,
			{ MIGADU_FETCH_FOR_TESTS: migaduFetch as typeof fetch } as Env,
			props,
		);

		await expect(dispatch.migadu_domains!({})).rejects.toThrow(
			"MIGADU_USER and MIGADU_API_KEY secrets are not configured",
		);
		expect(migaduFetch).not.toHaveBeenCalled();
	});

	it("classifies a rejected credential as non-retryable", async () => {
		const { dispatch } = createHarness([
			{ status: 401, body: { message: "Unauthorized" } },
		]);

		await expect(dispatch.migadu_domains!({})).rejects.toThrow(
			"will not succeed on retry",
		);
	});

	it("does not leak the api key from a transport error", async () => {
		const migaduFetch = vi.fn(async () => {
			throw new Error(apiKey);
		});
		const env = {
			MIGADU_USER: user,
			MIGADU_API_KEY: apiKey,
			MIGADU_FETCH_FOR_TESTS: migaduFetch as typeof fetch,
		} as unknown as Env;
		const dispatch = buildDispatchTable(migadu, env, props);

		let message = "";
		try {
			await dispatch.migadu_domains!({});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("could not be reached");
		expect(message).not.toContain(apiKey);
	});

	it("never includes the api key in an error message", async () => {
		const { dispatch } = createHarness([
			{ status: 401, body: { message: `Bad credentials: ${apiKey}` } },
		]);

		let message = "";
		try {
			await dispatch.migadu_domains!({});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("[redacted]");
		expect(message).not.toContain(apiKey);
	});

	it("rejects a local part with a slash before any fetch", async () => {
		const { migaduFetch, dispatch } = createHarness([]);

		await expect(
			dispatch.migadu_alias_delete!({
				domain: "example.com",
				local_part: "sales/../admin",
			}),
		).rejects.toThrow();
		expect(migaduFetch).not.toHaveBeenCalled();
	});
});

describe("Migadu read paths", () => {
	it("reads diagnostics and unwraps the mailbox and alias lists", async () => {
		const { sent, dispatch } = createHarness([
			{ body: { status: "passing", checks: { mx: "ok" } } },
			{ body: { mailboxes: [{ address: "hello@example.com", name: "Hello" }] } },
			{
				body: {
					address_aliases: [
						{ address: "contact@example.com", destinations: ["hello@example.com"] },
					],
				},
			},
		]);

		await dispatch.migadu_domain_diagnostics!({ domain: "Example.com" });
		expect(await dispatch.migadu_mailboxes!({ domain: "example.com" })).toEqual({
			mailboxes: [{ address: "hello@example.com", name: "Hello" }],
		});
		expect(await dispatch.migadu_aliases!({ domain: "example.com" })).toEqual({
			aliases: [
				{ address: "contact@example.com", destinations: ["hello@example.com"] },
			],
		});

		expect(sent.map((request) => request.url)).toEqual([
			"https://api.migadu.com/v1/domains/example.com/diagnostics",
			"https://api.migadu.com/v1/domains/example.com/mailboxes",
			"https://api.migadu.com/v1/domains/example.com/aliases",
		]);
	});
});
