import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./env";
import { searchCapabilities } from "./search";

function createServer(env: Env): McpServer {
	const server = new McpServer({ name: "ayo", version: "0.0.0" });

	server.registerTool(
		"search",
		{
			description:
				"Discover Ayo capabilities: blank query lists domains, normal text returns ranked matches, and an exact name or name:<capability> returns full details.",
			inputSchema: { query: z.string() },
		},
		async ({ query }) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify(await searchCapabilities(query, env)),
				},
			],
		}),
	);

	server.registerTool(
		"execute",
		{
			description: "Execute code against Ayo's capabilities",
			inputSchema: {
				code: z.string(),
				params: z.record(z.string(), z.unknown()).optional(),
			},
		},
		async () => ({
			content: [
				{
					type: "text",
					text: "Not implemented: sandboxed execution comes in a later roadmap step.",
				},
			],
			isError: true,
		}),
	);

	return server;
}

export const mcpHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/mcp") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		const server = createServer(env);
		await server.connect(transport);
		return transport.handleRequest(request);
	},
};
