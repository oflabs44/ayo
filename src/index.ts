import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { mcpHandler } from "./mcp";
import { accessHandler } from "./oauth/access-oidc";

export default new OAuthProvider<Env>({
	apiRoute: "/mcp",
	apiHandler: mcpHandler,
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
