import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env, OwnerProps } from "./env";
import { executeCode } from "./execute";
import { searchCapabilities } from "./search";

function createServer(env: Env, props: OwnerProps): McpServer {
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
			description:
				"Run JavaScript against Ayo capabilities through `ayo.<name>(input)`. The module must default-export a function. Put declarations inside that function: declarations above the default export can break codemode's wrapper. Outbound network access is blocked, `params` is available as a global object, and execution has a 30-second budget.",
			inputSchema: {
				code: z.string(),
				params: z.record(z.string(), z.unknown()).optional(),
			},
		},
		async ({ code, params }) => {
			const outcome = await executeCode({ code, params, env, props });
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							result: outcome.result ?? null,
							logs: outcome.logs,
							...(outcome.error !== undefined
								? { error: outcome.error }
								: {}),
						}),
					},
				],
				...(outcome.error !== undefined ? { isError: true } : {}),
			};
		},
	);

	return server;
}

export class McpHandler extends WorkerEntrypoint<Env, OwnerProps> {
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
		const server = createServer(this.env, this.ctx.props);
		await server.connect(transport);
		return transport.handleRequest(request);
	}
}
