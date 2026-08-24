import { z } from "zod";
import type { Capability, CapabilityContext } from "./index";

// Under the execute output ceiling so a response that passes here still has
// room to be returned beside the script's own result and logs.
const MAX_RESPONSE_CHARS = 64_000;

// A default and a ceiling: a default alone is overridden, a ceiling alone
// bounds nothing when the field is omitted and the model's own default is
// thousands of tokens. Over the ceiling is refused, not clamped - a silently
// reduced bound gives a truncated answer the caller reads as complete.
const DEFAULT_MAX_TOKENS = 512;
const MAX_TOKENS_CEILING = 4_096;
// Workers AI and chat models take max_tokens; OpenAI reasoning models require
// max_completion_tokens; the Responses shape uses max_output_tokens. Reading
// only one lets a limit under another name past the ceiling unchecked.
const TOKEN_LIMIT_FIELDS = [
	"max_tokens",
	"max_completion_tokens",
	"max_output_tokens",
] as const;

const runInputSchema = z.object({
	model: z.string().min(1).max(200),
	input: z
		.record(z.string(), z.unknown())
		.refine((value) => Object.keys(value).length > 0, {
			message:
				"Give the model an input - { prompt } or { messages }, depending on the model.",
		}),
	options: z
		.object({
			cache_ttl: z.number().int().min(60).max(2_592_000).optional(),
			skip_cache: z.boolean().optional(),
		})
		.optional(),
});

function withTokenCeiling(
	input: Record<string, unknown>,
): Record<string, unknown> {
	// Only text generation has a token limit; an embedding input gets no
	// injected field the provider did not ask for.
	if (!("prompt" in input) && !("messages" in input)) return input;

	const named = TOKEN_LIMIT_FIELDS.filter(
		(field) => input[field] !== undefined,
	);
	if (named.length === 0) return { ...input, max_tokens: DEFAULT_MAX_TOKENS };

	for (const field of named) {
		const asked = input[field];
		if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1) {
			throw new Error(
				`Refused: \`${field}\` must be a positive whole number.`,
			);
		}
		if (asked > MAX_TOKENS_CEILING) {
			throw new Error(
				`Refused: \`${field}\` is ${asked} and the ceiling is ${MAX_TOKENS_CEILING}. Ask for less, or split the work across calls.`,
			);
		}
	}
	return input;
}

function aiBinding({ env }: CapabilityContext) {
	// Both are permanent configuration facts, reported as such rather than as
	// a failed model call a caller might retry.
	if (!env.AI) {
		throw new Error(
			"Ayo cannot run a model here - the AI binding is not configured.",
		);
	}
	if (!env.AI_GATEWAY_ID) {
		throw new Error(
			"Ayo cannot run a model here - AI_GATEWAY_ID is not configured. Model calls route through an AI Gateway so inference is logged and traceable.",
		);
	}
	return { binding: env.AI, gatewayId: env.AI_GATEWAY_ID };
}

function binaryKind(value: unknown): string | null {
	if (value instanceof ArrayBuffer) return "an ArrayBuffer";
	if (ArrayBuffer.isView(value)) return "a typed array over binary data";
	if (value instanceof ReadableStream) return "a stream";
	if (typeof Blob !== "undefined" && value instanceof Blob) return "a Blob";
	if (typeof Response !== "undefined" && value instanceof Response)
		return "a Response";
	return null;
}

class BinaryInResponse extends Error {
	constructor(
		readonly kind: string,
		readonly at: string,
	) {
		super(kind);
	}
}

// The binary check rides on the serializer's own walk so the two cannot
// disagree about what was inspected: an ArrayBuffer at any depth serializes
// to {} without complaint, giving a successful-looking empty answer for a
// call that was billed.
function jsonOrRefuse(response: unknown, model: string): void {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(response, (key, value) => {
			const kind = binaryKind(value);
			if (kind !== null) throw new BinaryInResponse(kind, key);
			return value;
		});
	} catch (error) {
		if (error instanceof BinaryInResponse) {
			throw new Error(
				`\`${model}\` returned ${error.kind}${error.at ? ` in \`${error.at}\`` : ""}, and a capability result is JSON. Image, audio, and streaming models are not reachable through ai_run.`,
			);
		}
		throw new Error(
			`\`${model}\` returned something that is not JSON: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
	if (serialized === undefined) {
		throw new Error(`\`${model}\` returned nothing serializable.`);
	}
	if (serialized.length > MAX_RESPONSE_CHARS) {
		throw new Error(
			`\`${model}\` returned ${serialized.length.toLocaleString()} characters, over the ${MAX_RESPONSE_CHARS.toLocaleString()}-character ceiling. Ask for less - a lower max_tokens, a shorter input, or a model that answers with a label rather than an essay.`,
		);
	}
}

export const ai: Capability[] = [
	{
		name: "ai_run",
		description:
			"Run a model to judge, classify, extract, or summarize something: a Workers AI model like @cf/meta/llama-3.1-8b-instruct or a third-party one like openai/gpt-4.1-mini, with that model's own input object. Returns { response, log_id } where response is the provider's result unprojected; text and JSON only.",
		inputSchema: runInputSchema,
		keywords: [
			"run a model",
			"llm",
			"inference",
			"classify text",
			"summarize with ai",
			"extract a field",
			"prompt a model",
			"chat completion",
		],
		handler: async (rawInput, ctx) => {
			const { binding, gatewayId } = aiBinding(ctx);
			const { model, input, options } = rawInput as z.infer<
				typeof runInputSchema
			>;

			// Refused before the call: a stream is caught on the way out either
			// way, but by then the tokens are billed. Providers coerce, so
			// present-and-not-false rather than === true.
			if ("stream" in input && input.stream !== false) {
				throw new Error(
					"Refused: `stream` cannot cross into a capability result. Omit it, or pass false.",
				);
			}

			// The log id is a slot on the binding holding the most recent run's
			// id; compare before and after so a stale id is never returned as
			// this call's.
			const previousLogId = binding.aiGatewayLogId ?? null;

			// Bounded before the try: a token-ceiling refusal is Ayo's, and
			// wrapping it in provider-failure wording invites a retry.
			const boundedInput = withTokenCeiling(input);

			let response: unknown;
			try {
				response = await binding.run(model, boundedInput, {
					gateway: {
						id: gatewayId,
						...(options?.skip_cache === undefined
							? {}
							: { skipCache: options.skip_cache }),
						...(options?.cache_ttl === undefined
							? {}
							: { cacheTtl: options.cache_ttl }),
					},
				});
			} catch (error) {
				throw new Error(
					`The model call to \`${model}\` failed: ${error instanceof Error ? error.message : String(error)}. The model name and input shape are the provider's - check them against the Cloudflare model catalogue before retrying.`,
				);
			}

			jsonOrRefuse(response, model);

			const logId = binding.aiGatewayLogId ?? null;
			return { response, log_id: logId === previousLogId ? null : logId };
		},
	},
];
