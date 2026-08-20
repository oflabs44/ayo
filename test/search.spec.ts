import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { searchCapabilities } from "../src/search";

const offlineEnv = { SEARCH_OFFLINE: "true" } as Env;

describe("capability search", () => {
	it("returns a domain overview for a blank query", async () => {
		expect(await searchCapabilities("  \n", offlineEnv)).toEqual({
			domains: [
				{
					domain: "meta",
					description: "Capabilities for introspection and discovery",
					capabilities: ["whoami", "capabilities_list"],
				},
				{
					domain: "notebook",
					description: "Write, read, list, and delete private notebook pages",
					capabilities: [
						"notebook_write",
						"notebook_read",
						"notebook_list",
						"notebook_delete",
						"notebook_history",
					],
				},
				{
					domain: "memory",
					description: "Remember, recall, and forget facts about the owner",
					capabilities: [
						"memory_remember",
						"memory_recall",
						"memory_forget",
					],
				},
			],
		});
	});

	it("returns ranked matches for a normal query", async () => {
		expect(await searchCapabilities("identity", offlineEnv)).toMatchObject({
			matches: [
				{
					name: "whoami",
					domain: "meta",
					inputSchema: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
					callExample: "await ayo.whoami({})",
				},
			],
		});
	});

	it("returns full detail for an exact entity lookup", async () => {
		expect(
			await searchCapabilities("name:capabilities_list", offlineEnv),
		).toMatchObject({
			capability: {
				name: "capabilities_list",
				domain: "meta",
				keywords: ["capabilities", "discovery", "registry", "tools"],
				callExample: "await ayo.capabilities_list({})",
			},
		});
	});

	it("orders matches by weighted body and identity overlap", async () => {
		const result = (await searchCapabilities(
			"capabilities caller",
			offlineEnv,
		)) as { matches: Array<{ name: string }> };

		expect(result.matches.map(({ name }) => name)).toEqual([
			"capabilities_list",
			"whoami",
		]);
	});

	it("self-indexes and fuses mocked semantic results", async () => {
		const aiRun = vi.fn(
			async (_model: string, input: { text: string[] }) => ({
				data: input.text.map(() => Array<number>(384).fill(0)),
			}),
		);
		const upsert = vi.fn(async () => undefined);
		const query = vi.fn(async () => ({
			matches: [
				{ id: "capability:capabilities_list", score: 0.9 },
				{ id: "capability:whoami", score: 0.8 },
			],
		}));
		const put = vi.fn(async () => undefined);
		const onlineEnv = {
			AI: { run: aiRun },
			VECTORIZE: { upsert, query },
			OAUTH_KV: {
				get: vi.fn(async () => null),
				put,
			},
		} as unknown as Env;

		const result = (await searchCapabilities("profile", onlineEnv)) as {
			matches: Array<{ name: string }>;
		};

		expect(result.matches.map(({ name }) => name)).toEqual([
			"whoami",
			"capabilities_list",
		]);
		expect(result).not.toHaveProperty("offline");
		expect(aiRun).toHaveBeenCalledTimes(2);
		expect(aiRun).toHaveBeenNthCalledWith(
			1,
			"@cf/baai/bge-small-en-v1.5",
			{
				text: [
					expect.stringContaining("whoami\nmeta"),
					expect.stringContaining("capabilities_list\nmeta"),
					expect.stringContaining("notebook_write\nnotebook"),
					expect.stringContaining("notebook_read\nnotebook"),
					expect.stringContaining("notebook_list\nnotebook"),
					expect.stringContaining("notebook_delete\nnotebook"),
					expect.stringContaining("notebook_history\nnotebook"),
					expect.stringContaining("memory_remember\nmemory"),
					expect.stringContaining("memory_recall\nmemory"),
					expect.stringContaining("memory_forget\nmemory"),
				],
			},
		);
		expect(aiRun).toHaveBeenNthCalledWith(
			2,
			"@cf/baai/bge-small-en-v1.5",
			{ text: ["profile"] },
		);
		expect(upsert).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "capability:whoami",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:capabilities_list",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_write",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_read",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_list",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_history",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:memory_remember",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:memory_recall",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:memory_forget",
				namespace: "capabilities",
			}),
		]);
		expect(query).toHaveBeenCalledWith(expect.any(Array), {
			topK: 10,
			namespace: "capabilities",
		});
		expect(put).toHaveBeenCalledWith(
			"search:capabilities:content-stamp",
			expect.any(String),
		);
	});
});
