import { describe, expect, it } from "vitest";
import { searchCapabilities } from "../src/search";

describe("capability search", () => {
	it("returns a domain overview for a blank query", () => {
		expect(searchCapabilities("  \n")).toEqual({
			domains: [
				{
					domain: "meta",
					description: "Capabilities for introspection and discovery",
					capabilities: ["whoami", "capabilities_list"],
				},
			],
		});
	});

	it("returns ranked matches for a normal query", () => {
		expect(searchCapabilities("identity")).toMatchObject({
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

	it("returns full detail for an exact entity lookup", () => {
		expect(searchCapabilities("name:capabilities_list")).toMatchObject({
			capability: {
				name: "capabilities_list",
				domain: "meta",
				keywords: ["capabilities", "discovery", "registry", "tools"],
				callExample: "await ayo.capabilities_list({})",
			},
		});
	});

	it("orders keyword matches before description matches", () => {
		const result = searchCapabilities("caller") as {
			matches: Array<{ name: string }>;
		};

		expect(result.matches.map(({ name }) => name)).toEqual([
			"whoami",
			"capabilities_list",
		]);
	});
});
