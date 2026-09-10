import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext, ScheduledController } from "cloudflare:workers";
import { handleDocumentFile, handleDocumentUpload } from "./documents/routes";
import { pruneExpiredTickets } from "./documents/tickets";
import type { Env } from "./env";
import { handleHook } from "./hooks";
import { runDueJobs } from "./jobs/runner";
import { McpHandler } from "./mcp";
import { accessHandler } from "./oauth/access-oidc";

const oauthProvider = new OAuthProvider<Env>({
	apiRoute: "/mcp",
	apiHandler: McpHandler,
	defaultHandler: accessHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	scopesSupported: ["mcp"],
	resourceMetadata: {
		scopes_supported: ["mcp"],
		resource_name: "Ayo MCP server",
	},
});

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

		return oauthProvider.fetch(request, env, ctx);
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
