import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { searchCapabilities } from "../src/search";

const offlineEnv = { SEARCH_OFFLINE: "true" } as Env;

const goldenQueries = [
	["who am i", "whoami"],
	["what can you do", "overview"],
	["list everything you can do", "capabilities_list"],
	["show my profile", "whoami"],
	["show available tools", "capabilities_list"],
	["browse the capability registry", "capabilities_list"],
] as const;

describe("capability search golden queries", () => {
	it.each(goldenQueries)("%s", async (query, expected) => {
		const result = await searchCapabilities(query, offlineEnv);
		if (expected === "overview") {
			expect(result).toHaveProperty("domains");
			return;
		}

		const ranked = result as { matches: Array<{ name: string }> };
		expect(ranked.matches[0]?.name).toBe(expected);
		expect(ranked).toMatchObject({ offline: true });
	});
});
