import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext, ScheduledController } from "cloudflare:workers";
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

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
		const path = new URL(request.url).pathname;
		const hookMatch = /^\/hooks\/([^/]+)$/.exec(path);
		if (hookMatch === null) return oauthProvider.fetch(request, env, ctx);
		if (request.method !== "POST") return new Response(null, { status: 404 });
		return handleHook(request, env, ctx, hookMatch[1]!);
	},
	scheduled: (
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) => runDueJobs(env, ctx),
};
