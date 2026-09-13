import { z } from "zod";
import type { Capability, CapabilityContext } from "./index";

const API_ORIGIN = "https://api.migadu.com/v1";

const domainNamePattern =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const localPartPattern = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/i;

// No .transform(): the input schema is also rendered as a JSON Schema for
// search, which cannot represent zod transforms. Lowercasing happens where
// these fields are used instead.
const domainNameField = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(
		domainNamePattern,
		"A domain name must be a bare hostname with no spaces or slashes, e.g. example.com.",
	);

const localPartField = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(
		localPartPattern,
		"A local part must be lowercase with no spaces or slashes, e.g. billing.",
	);

function lower(value: string): string {
	return value.toLowerCase();
}

function domainPath(domain: string, suffix = ""): string {
	return `/domains/${encodeURIComponent(lower(domain))}${suffix}`;
}

const domainSchema = z.object({
	name: z.string(),
	state: z.string().optional(),
	description: z.string().optional(),
});
const mailboxSchema = z.object({
	address: z.string(),
	name: z.string().optional(),
});
const aliasSchema = z.object({
	address: z.string(),
	destinations: z.array(z.string()).optional(),
});
const dnsRecordSchema = z.object({
	name: z.string(),
	type: z.string(),
	value: z.string(),
	priority: z.number().optional(),
});
const domainRecordsSchema = z.object({
	domain_name: z.string().optional(),
	dkim: z.array(dnsRecordSchema).optional(),
	dmarc: dnsRecordSchema.optional(),
	dns_verification: dnsRecordSchema.optional(),
	mx_records: z.array(dnsRecordSchema).optional(),
	spf: dnsRecordSchema.optional(),
});

type Domain = z.infer<typeof domainSchema>;
type Mailbox = z.infer<typeof mailboxSchema>;
type Alias = z.infer<typeof aliasSchema>;

function toDomain(domain: Domain) {
	return {
		name: domain.name,
		state: domain.state ?? null,
		description: domain.description ?? null,
	};
}

function toMailbox(mailbox: Mailbox) {
	return { address: mailbox.address, name: mailbox.name ?? null };
}

function toAlias(alias: Alias) {
	return { address: alias.address, destinations: alias.destinations ?? [] };
}

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function migaduMessage(body: string, apiKey: string): string {
	try {
		const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
		const message =
			typeof parsed.message === "string"
				? parsed.message
				: typeof parsed.error === "string"
					? parsed.error
					: undefined;
		return message
			? ` Migadu said: ${clip(message.split(apiKey).join("[redacted]"), 300)}`
			: "";
	} catch {
		return "";
	}
}

function classify(
	response: Response,
	body: string,
	operation: string,
	apiKey: string,
): Error {
	const hint = migaduMessage(body, apiKey);

	if (response.status === 401 || response.status === 403) {
		return new Error(
			`Migadu rejected Ayo's credential for ${operation}. MIGADU_USER or MIGADU_API_KEY is missing, wrong, or revoked; this will not succeed on retry. Oladayo must replace the secret out of band with \`pnpm exec wrangler secret put MIGADU_API_KEY\`.${hint}`,
		);
	}

	if (response.status === 404) {
		return new Error(
			`Migadu has no such thing for ${operation}. Check the domain name or local part.${hint}`,
		);
	}

	if (response.status === 422) {
		return new Error(
			`Migadu refused ${operation}: validation or a DNS check failed.${hint || " No further detail was given."}`,
		);
	}

	return new Error(
		`Migadu refused ${operation} with HTTP ${response.status}.${hint}`,
	);
}

async function migaduRequest(
	ctx: CapabilityContext,
	operation: string,
	request: { method: string; path: string; body?: unknown },
): Promise<unknown> {
	const user = ctx.env.MIGADU_USER;
	const key = ctx.env.MIGADU_API_KEY;
	if (!user || !key) {
		throw new Error(
			"Ayo cannot reach Migadu here - the MIGADU_USER and MIGADU_API_KEY secrets are not configured. Oladayo must set them out of band with `pnpm exec wrangler secret put MIGADU_USER` and `pnpm exec wrangler secret put MIGADU_API_KEY`.",
		);
	}

	let response: Response;
	try {
		const fetchMigadu = ctx.env.MIGADU_FETCH_FOR_TESTS ?? fetch;
		response = await fetchMigadu(`${API_ORIGIN}${request.path}`, {
			method: request.method,
			headers: {
				authorization: `Basic ${btoa(`${user}:${key}`)}`,
				accept: "application/json",
				...(request.body === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(request.body === undefined
				? {}
				: { body: JSON.stringify(request.body) }),
		});
	} catch {
		// Do not include the thrown value: a fetch implementation can include
		// request headers in its error, and the API key must never cross this boundary.
		throw new Error(
			`Migadu could not be reached for ${operation}. Check Ayo's network access before retrying.`,
		);
	}

	let text: string;
	try {
		text = await response.text();
	} catch {
		throw new Error(
			`Migadu's response body could not be read for ${operation}. Retry once; if it repeats, check Migadu's status.`,
		);
	}

	if (!response.ok) {
		throw classify(response, text, operation, key);
	}

	if (text.length === 0) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(
			`Migadu returned something that is not JSON for ${operation}. The response was not usable; check Migadu's status before retrying.`,
		);
	}
}

function parseResponse<T>(
	schema: z.ZodType<T>,
	value: unknown,
	operation: string,
): T {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;

	throw new Error(
		`Migadu returned an invalid response for ${operation}. The call cannot be completed safely; retry once, then check the Migadu integration if it repeats.`,
	);
}

const domainInputSchema = z.object({ domain: domainNameField });
const domainCreateInputSchema = z.object({
	name: domainNameField,
	create_default_addresses: z.boolean().default(true),
});
const mailboxCreateInputSchema = domainInputSchema.extend({
	local_part: localPartField,
	name: z.string().trim().min(1).max(200),
	password_recovery_email: z.email(),
});
const aliasCreateInputSchema = domainInputSchema.extend({
	local_part: localPartField,
	destinations: z.array(z.email()).min(1).max(50),
	is_internal: z.boolean().optional(),
});
const aliasDeleteInputSchema = domainInputSchema.extend({
	local_part: localPartField,
});

export const migadu: Capability[] = [
	{
		name: "migadu_domains",
		description:
			"List the custom email hosting domains onboarded to Migadu, with their activation state.",
		keywords: [
			"migadu",
			"email hosting",
			"custom domain",
			"list domains",
			"hosted domains",
		],
		inputSchema: z.object({}),
		handler: async (_input, ctx) => {
			const response = await migaduRequest(ctx, "the domain list", {
				method: "GET",
				path: "/domains",
			});
			const { domains } = parseResponse(
				z.object({ domains: z.array(domainSchema) }),
				response,
				"the domain list",
			);
			return { domains: domains.map(toDomain) };
		},
	},
	{
		name: "migadu_domain_create",
		description:
			"Onboard a new custom domain to Migadu email hosting so it can send and receive mail. DNS still needs to be set at the registrar before it activates; use migadu_domain_records for the records to add and migadu_domain_activate once DNS is live.",
		keywords: [
			"migadu",
			"add domain",
			"new email domain",
			"custom domain",
			"onboard domain",
			"email hosting",
		],
		inputSchema: domainCreateInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof domainCreateInputSchema>;
			const response = await migaduRequest(ctx, "the domain creation", {
				method: "POST",
				path: "/domains",
				body: {
					name: lower(args.name),
					create_default_addresses: args.create_default_addresses,
					hosted_dns: false,
				},
			});
			const domain = parseResponse(
				domainSchema,
				response,
				"the domain creation",
			);
			return toDomain(domain);
		},
	},
	{
		name: "migadu_domain_records",
		description:
			"Get the DNS records Migadu expects for a domain (MX, SPF, DKIM, DMARC, verification) so they can be added at the domain's registrar.",
		keywords: [
			"migadu",
			"dns records",
			"mx record",
			"spf",
			"dkim",
			"dmarc",
			"domain verification",
		],
		inputSchema: domainInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof domainInputSchema>;
			const response = await migaduRequest(ctx, "the DNS records lookup", {
				method: "GET",
				path: domainPath(args.domain, "/records"),
			});
			return parseResponse(
				domainRecordsSchema,
				response,
				"the DNS records lookup",
			);
		},
	},
	{
		name: "migadu_domain_diagnostics",
		description:
			"Check Migadu's diagnostics for a domain to see whether its DNS records currently look correct.",
		keywords: [
			"migadu",
			"domain diagnostics",
			"check dns",
			"domain health",
			"dns problems",
		],
		inputSchema: domainInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof domainInputSchema>;
			const response = await migaduRequest(ctx, "the domain diagnostics", {
				method: "GET",
				path: domainPath(args.domain, "/diagnostics"),
			});
			return parseResponse(
				z.record(z.string(), z.unknown()),
				response,
				"the domain diagnostics",
			);
		},
	},
	{
		name: "migadu_domain_activate",
		description:
			"Activate a Migadu domain once its DNS records are live. Fails with an actionable message if DNS is not ready yet.",
		keywords: [
			"migadu",
			"activate domain",
			"finish domain setup",
			"enable domain",
			"email hosting",
		],
		inputSchema: domainInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof domainInputSchema>;
			const response = await migaduRequest(ctx, "the domain activation", {
				method: "GET",
				path: domainPath(args.domain, "/activate"),
			});
			const domain = parseResponse(
				domainSchema,
				response,
				"the domain activation",
			);
			return toDomain(domain);
		},
	},
	{
		name: "migadu_mailboxes",
		description:
			"List the email addresses (mailboxes) on a Migadu domain. This is Migadu's own address list, not the IMAP folders inside a mailbox.",
		keywords: [
			"migadu",
			"list email addresses",
			"mailboxes",
			"custom domain addresses",
			"email hosting",
		],
		inputSchema: domainInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof domainInputSchema>;
			const response = await migaduRequest(ctx, "the mailbox list", {
				method: "GET",
				path: domainPath(args.domain, "/mailboxes"),
			});
			const { mailboxes } = parseResponse(
				z.object({ mailboxes: z.array(mailboxSchema) }),
				response,
				"the mailbox list",
			);
			return { mailboxes: mailboxes.map(toMailbox) };
		},
	},
	{
		name: "migadu_mailbox_create",
		description:
			"Create a new email address (mailbox) on a Migadu domain. The new owner sets their own password by invitation; Ayo never handles or stores mailbox passwords.",
		keywords: [
			"migadu",
			"new email address",
			"create mailbox",
			"add address",
			"email hosting",
		],
		inputSchema: mailboxCreateInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof mailboxCreateInputSchema>;
			const response = await migaduRequest(ctx, "the mailbox creation", {
				method: "POST",
				path: domainPath(args.domain, "/mailboxes"),
				body: {
					local_part: lower(args.local_part),
					name: args.name,
					password_recovery_email: args.password_recovery_email,
					password_method: "invitation",
				},
			});
			const mailbox = parseResponse(
				mailboxSchema,
				response,
				"the mailbox creation",
			);
			return toMailbox(mailbox);
		},
	},
	{
		name: "migadu_aliases",
		description:
			"List the email aliases on a Migadu domain and the addresses each one forwards to.",
		keywords: [
			"migadu",
			"list aliases",
			"email alias",
			"forwarding address",
			"email hosting",
		],
		inputSchema: domainInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof domainInputSchema>;
			const response = await migaduRequest(ctx, "the alias list", {
				method: "GET",
				path: domainPath(args.domain, "/aliases"),
			});
			const { address_aliases } = parseResponse(
				z.object({ address_aliases: z.array(aliasSchema) }),
				response,
				"the alias list",
			);
			return { aliases: address_aliases.map(toAlias) };
		},
	},
	{
		name: "migadu_alias_create",
		description:
			"Create an email alias on a Migadu domain that forwards to one or more existing addresses.",
		keywords: [
			"migadu",
			"create alias",
			"forwarding address",
			"new email alias",
			"email hosting",
		],
		inputSchema: aliasCreateInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof aliasCreateInputSchema>;
			const response = await migaduRequest(ctx, "the alias creation", {
				method: "POST",
				path: domainPath(args.domain, "/aliases"),
				body: {
					local_part: lower(args.local_part),
					destinations: args.destinations,
					...(args.is_internal === undefined
						? {}
						: { is_internal: args.is_internal }),
				},
			});
			const alias = parseResponse(
				aliasSchema,
				response,
				"the alias creation",
			);
			return toAlias(alias);
		},
	},
	{
		name: "migadu_alias_delete",
		description:
			"Delete an email alias from a Migadu domain.",
		keywords: [
			"migadu",
			"delete alias",
			"remove forwarding address",
			"email hosting",
		],
		inputSchema: aliasDeleteInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof aliasDeleteInputSchema>;
			await migaduRequest(ctx, "the alias deletion", {
				method: "DELETE",
				path: domainPath(
					args.domain,
					`/aliases/${encodeURIComponent(lower(args.local_part))}`,
				),
			});
			return {
				deleted: true,
				address: `${lower(args.local_part)}@${lower(args.domain)}`,
			};
		},
	},
];
