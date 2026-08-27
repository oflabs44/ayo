import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext, ScheduledController } from "cloudflare:workers";
import type { Env } from "./env";
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
	fetch: oauthProvider.fetch.bind(oauthProvider),
	scheduled: (
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) => runDueJobs(env, ctx),
};
