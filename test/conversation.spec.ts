import { describe, expect, it } from "vitest";
import { mintConversationId } from "../src/conversation";

describe("conversation identity", () => {
	it("mints a UUID", () => {
		expect(mintConversationId()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});
