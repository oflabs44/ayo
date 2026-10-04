import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext, ScheduledController } from "cloudflare:workers";
import { handleDocumentFile, handleDocumentUpload } from "./documents/routes";
import { pruneExpiredTickets } from "./documents/tickets";
import type { Env } from "./env";
import { handleHook } from "./hooks";
import { runDueJobs } from "./jobs/runner";
import { McpHandler } from "./mcp";
import { accessHandler } from "./oauth/access-oidc";

// The provider needs the canonical resource (every token's audience) at
// construction, and it must come from PUBLIC_BASE_URL, which only exists on
// env. So the provider is built on first request and cached: PUBLIC_BASE_URL
// is a plain var, constant for the life of the isolate.
let oauthProvider: OAuthProvider<Env> | undefined;

function oauthProviderFor(env: Env): OAuthProvider<Env> {
	oauthProvider ??= new OAuthProvider<Env>({
		apiRoute: "/mcp",
		apiHandler: McpHandler,
		defaultHandler: accessHandler,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
		scopesSupported: ["mcp"],
		requiredScopes: ["mcp"],
		resourceMetadata: {
			resource: `${env.PUBLIC_BASE_URL}/mcp`,
			resource_name: "Ayo MCP server",
		},
	});
	return oauthProvider;
}

function methodNotAllowed(allow: string): Response {
	return new Response(null, { status: 405, headers: { Allow: allow } });
}

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
		const path = new URL(request.url).pathname;

		const hookMatch = /^\/hooks\/([^/]+)$/.exec(path);
		if (hookMatch !== null) {
			if (request.method !== "POST") return new Response(null, { status: 404 });
			return handleHook(request, env, ctx, hookMatch[1]!);
		}

		// Unauthenticated: the opaque, single-use ticket is the credential,
		// minted by document_upload/document_file and never the caller's
		// OAuth bearer token.
		const uploadMatch = /^\/documents\/upload\/([^/]+)$/.exec(path);
		if (uploadMatch !== null) {
			if (request.method !== "PUT") return methodNotAllowed("PUT");
			return handleDocumentUpload(request, env, uploadMatch[1]!);
		}
		const fileMatch = /^\/documents\/file\/([^/]+)$/.exec(path);
		if (fileMatch !== null) {
			if (request.method !== "GET") return methodNotAllowed("GET");
			return handleDocumentFile(env, fileMatch[1]!);
		}

		return oauthProviderFor(env).fetch(request, env, ctx);
	},
	scheduled: (
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) => {
		ctx.waitUntil(
			pruneExpiredTickets(env, Date.now()).catch((error) =>
				console.error("ayo document ticket pruning failed", error),
			),
		);
		return runDueJobs(env, ctx);
	},
};
