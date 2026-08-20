import { describe, expect, it, vi } from "vitest";
import {
	alreadySurfaced,
	markSurfaced,
	mintConversationId,
	SUPPRESSION_TTL_SECONDS,
} from "../src/conversation";
import type { Env } from "../src/env";

function createTestEnv() {
	const values = new Map<string, string>();
	const get = vi.fn(async (key: string) => values.get(key) ?? null);
	const put = vi.fn(
		async (key: string, value: string, _options: { expirationTtl: number }) => {
			values.set(key, value);
		},
	);
	return {
		env: { OAUTH_KV: { get, put } } as unknown as Env,
		put,
	};
}

describe("conversation identity", () => {
	it("mints a UUID", () => {
		expect(mintConversationId()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});

describe("conversation suppression", () => {
	it("marks generic keys as surfaced for six hours", async () => {
		const { env, put } = createTestEnv();

		await expect(alreadySurfaced(env, "conversation-1", "memory:1")).resolves.toBe(
			false,
		);
		await markSurfaced(env, "conversation-1", ["memory:1", "notice"]);

		await expect(alreadySurfaced(env, "conversation-1", "memory:1")).resolves.toBe(
			true,
		);
		expect(put).toHaveBeenCalledWith(
			"suppress:conversation-1:memory%3A1",
			"1",
			{ expirationTtl: SUPPRESSION_TTL_SECONDS },
		);
		expect(put).toHaveBeenCalledWith("suppress:conversation-1:notice", "1", {
			expirationTtl: SUPPRESSION_TTL_SECONDS,
		});
	});

	it("keeps suppression separate between conversations", async () => {
		const { env } = createTestEnv();
		await markSurfaced(env, "conversation-1", ["shared-key"]);

		await expect(
			alreadySurfaced(env, "conversation-1", "shared-key"),
		).resolves.toBe(true);
		await expect(
			alreadySurfaced(env, "conversation-2", "shared-key"),
		).resolves.toBe(false);
	});
	it("does not collide colon-bearing ids with shifted key boundaries", async () => {
		const { env, put } = createTestEnv();
		await markSurfaced(env, "a", ["b:c"]);
		expect(await alreadySurfaced(env, "a:b", "c")).toBe(false);
		expect(await alreadySurfaced(env, "a", "b:c")).toBe(true);
		expect(put).toHaveBeenCalledTimes(1);
	});

});
