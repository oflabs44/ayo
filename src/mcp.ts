import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { mintConversationId } from "./conversation";
import type { Env, OwnerProps } from "./env";
import { executeCode } from "./execute";
import { surfaceMemories } from "./memory/surface";
import { getNotebookStore } from "./notebook/resolve";
import { searchCapabilities } from "./search";

const MEMORY_CONTEXT_DESCRIPTION =
	"Optionally pass memoryContext, a brief task hint, to receive relevant remembered facts alongside the result.";
const SERVER_INSTRUCTIONS =
	"Ayo is your personal assistant. Use search to discover capabilities and execute to act through them. On tool calls, include a brief memoryContext describing the task; Ayo returns compact memory one-liners with the result. Repeats are expected; use memory_recall with a returned path for full content. If you have a conversationId from an earlier result in the same conversation, pass it back unchanged. Otherwise omit conversationId and reuse the id returned by Ayo on later calls. Do not make one up. Before filing a new memory, consult memory/readme.";
const conversationIdInput = z.string().min(1).max(128).optional();
const memoryContextInput = z.string().min(1).max(500).optional();

async function memoriesForContext(env: Env, memoryContext: string | undefined) {
	if (!memoryContext) return [];
	const store = getNotebookStore(env);
	if (!store) {
		console.error("memoryContext ignored: notebook backend is not configured");
		return [];
	}
	return surfaceMemories(env, store, memoryContext);
}

function createServer(env: Env, props: OwnerProps): McpServer {
	const server = new McpServer(
		{ name: "ayo", version: "0.0.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	server.registerTool(
		"search",
		{
			description: `Discover Ayo capabilities: blank query lists domains, normal text returns ranked matches, and an exact name or name:<capability> returns full details. Pass back a conversationId unchanged to echo it, or omit it to receive one. ${MEMORY_CONTEXT_DESCRIPTION}`,
			inputSchema: {
				query: z.string(),
				conversationId: conversationIdInput,
				memoryContext: memoryContextInput,
			},
		},
		async ({
			query,
			conversationId: providedConversationId,
			memoryContext,
		}) => {
			const conversationId = providedConversationId ?? mintConversationId();
			const result = await searchCapabilities(query, env);
			const memories = await memoriesForContext(env, memoryContext);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							...result,
							conversationId,
							...(memories.length > 0 ? { memories } : {}),
						}),
					},
				],
			};
		},
	);

	server.registerTool(
		"execute",
		{
			description: `Run JavaScript against Ayo capabilities through \`ayo.<name>(input)\`. The module must default-export a function. Put declarations inside that function: declarations above the default export can break codemode's wrapper. Outbound network access is blocked, \`params\` is available as a global object, and execution has a 30-second budget. Pass back a conversationId unchanged to echo it, or omit it to receive one. ${MEMORY_CONTEXT_DESCRIPTION}`,
			inputSchema: {
				code: z.string(),
				params: z.record(z.string(), z.unknown()).optional(),
				conversationId: conversationIdInput,
				memoryContext: memoryContextInput,
			},
		},
		async ({
			code,
			params,
			conversationId: providedConversationId,
			memoryContext,
		}) => {
			const conversationId = providedConversationId ?? mintConversationId();
			const outcome = await executeCode({ code, params, env, props });
			const memories = await memoriesForContext(env, memoryContext);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							conversationId,
							result: outcome.result ?? null,
							logs: outcome.logs,
							...(outcome.error !== undefined
								? { error: outcome.error }
								: {}),
							...(memories.length > 0 ? { memories } : {}),
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
