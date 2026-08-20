import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

function createServer(): McpServer {
	const server = new McpServer({ name: "ayo", version: "0.0.0" });

	server.registerTool(
		"search",
		{
			description: "Search Ayo's capabilities",
			inputSchema: { query: z.string() },
		},
		async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						capabilities: [],
						note: "The capability registry is not implemented yet.",
					}),
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
	async fetch(request: Request): Promise<Response> {
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
		const server = createServer();
		await server.connect(transport);
		return transport.handleRequest(request);
	},
};
