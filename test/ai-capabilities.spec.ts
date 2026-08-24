import { describe, expect, it, vi } from "vitest";
import { ai } from "../src/capabilities/ai";
import type { Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

function createHarness(response: unknown = { response: "a label" }) {
	const binding = {
		run: vi.fn(async () => response),
		aiGatewayLogId: null as string | null,
	};
	const env = { AI: binding, AI_GATEWAY_ID: "default" } as unknown as Env;
	return { binding, dispatch: buildDispatchTable(ai, env, props) };
}

describe("ai_run", () => {
	it("injects the default token limit, pins the gateway, and returns the whole response", async () => {
		const { binding, dispatch } = createHarness({
			response: "a label",
			usage: { total_tokens: 12 },
		});

		const result = await dispatch.ai_run!({
			model: "@cf/meta/llama-3.1-8b-instruct",
			input: { prompt: "label this" },
		});
		expect(binding.run).toHaveBeenCalledWith(
			"@cf/meta/llama-3.1-8b-instruct",
			{ prompt: "label this", max_tokens: 512 },
			{ gateway: { id: "default" } },
		);
		expect(result).toEqual({
			response: { response: "a label", usage: { total_tokens: 12 } },
			log_id: null,
		});
	});

	it.each([
		"max_tokens",
		"max_completion_tokens",
		"max_output_tokens",
	])("refuses %s above the ceiling and injects no duplicate beside it", async (field) => {
		const { binding, dispatch } = createHarness();

		await expect(
			dispatch.ai_run!({
				model: "openai/gpt-4.1-mini",
				input: { messages: [], [field]: 10_000 },
			}),
		).rejects.toThrow("ceiling is 4096");
		expect(binding.run).not.toHaveBeenCalled();

		await dispatch.ai_run!({
			model: "openai/gpt-4.1-mini",
			input: { messages: [], [field]: 100 },
		});
		expect(binding.run).toHaveBeenCalledWith(
			"openai/gpt-4.1-mini",
			{ messages: [], [field]: 100 },
			expect.anything(),
		);
	});

	it("refuses stream before the call, including coerced values", async () => {
		const { binding, dispatch } = createHarness();

		await expect(
			dispatch.ai_run!({
				model: "openai/gpt-4.1-mini",
				input: { prompt: "hi", stream: 1 },
			}),
		).rejects.toThrow("`stream` cannot cross");
		expect(binding.run).not.toHaveBeenCalled();
	});

	it("refuses binary nested anywhere in the response", async () => {
		const { dispatch } = createHarness({ image: new ArrayBuffer(8) });

		await expect(
			dispatch.ai_run!({
				model: "@cf/some/image-model",
				input: { prompt: "draw" },
			}),
		).rejects.toThrow("ArrayBuffer");
	});

	it("refuses a response over the size ceiling", async () => {
		const { dispatch } = createHarness({ response: "x".repeat(65_000) });

		await expect(
			dispatch.ai_run!({
				model: "@cf/meta/llama-3.1-8b-instruct",
				input: { prompt: "essay" },
			}),
		).rejects.toThrow("64,000-character ceiling");
	});

	it("returns this call's gateway log id and null when it is stale", async () => {
		const { binding, dispatch } = createHarness();
		binding.aiGatewayLogId = "log-previous";

		const stale = (await dispatch.ai_run!({
			model: "@cf/meta/llama-3.1-8b-instruct",
			input: { prompt: "one" },
		})) as { log_id: string | null };
		expect(stale.log_id).toBeNull();

		binding.run.mockImplementationOnce(async () => {
			binding.aiGatewayLogId = "log-fresh";
			return { response: "ok" };
		});
		const fresh = (await dispatch.ai_run!({
			model: "@cf/meta/llama-3.1-8b-instruct",
			input: { prompt: "two" },
		})) as { log_id: string | null };
		expect(fresh.log_id).toBe("log-fresh");
	});

	it("reports a missing binding as configuration, not a failed call", async () => {
		const env = { AI_GATEWAY_ID: "default" } as unknown as Env;
		const dispatch = buildDispatchTable(ai, env, props);

		await expect(
			dispatch.ai_run!({ model: "openai/gpt-4.1-mini", input: { prompt: "hi" } }),
		).rejects.toThrow("the AI binding is not configured");
	});

	it("refuses to run without a gateway id before calling the provider", async () => {
		const { binding } = createHarness();
		const env = { AI: binding } as unknown as Env;
		const dispatch = buildDispatchTable(ai, env, props);

		await expect(
			dispatch.ai_run!({ model: "openai/gpt-4.1-mini", input: { prompt: "hi" } }),
		).rejects.toThrow("AI_GATEWAY_ID is not configured");
		expect(binding.run).not.toHaveBeenCalled();
	});
});
