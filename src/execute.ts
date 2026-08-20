import type { Capability } from "./capabilities";
import { capabilities } from "./capabilities";
import type { Env, OwnerProps } from "./env";

const TIMEOUT_MS = 30_000;

export type ExecuteOutcome = {
	result?: unknown;
	logs: string[];
	error?: string;
};

export async function executeCode(input: {
	code: string;
	params?: Record<string, unknown>;
	env: Env;
	props: OwnerProps;
}): Promise<ExecuteOutcome> {
	if (!input.env.LOADER) {
		return {
			logs: [],
			error:
				"The sandbox is unavailable: no LOADER binding. Capabilities cannot run.",
		};
	}

	const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
	const executor = new DynamicWorkerExecutor({
		loader: input.env.LOADER,
		timeout: TIMEOUT_MS,
		globalOutbound: null,
	});
	const startedAt = Date.now();

	try {
		const outcome = await executor.execute(input.code, [
			{
				name: "ayo",
				fns: buildDispatchTable(capabilities, input.props),
				prelude: `const params = ${JSON.stringify(input.params ?? {})};`,
			},
		]);

		return {
			result: outcome.result,
			logs: outcome.logs ?? [],
			...(outcome.error !== undefined
				? { error: describeError(outcome.error, Date.now() - startedAt) }
				: {}),
		};
	} catch (error) {
		// Codemode can throw while loading invalid wrapped source despite its
		// ExecuteResult contract, so script errors stay inside the tool outcome.
		return {
			logs: [],
			error: describeError(
				error instanceof Error ? error.message : String(error),
				Date.now() - startedAt,
			),
		};
	}
}

export function buildDispatchTable(
	registry: Capability[],
	props: OwnerProps,
): Record<string, (input: unknown) => Promise<unknown>> {
	return Object.fromEntries(
		registry.map((capability) => [
			capability.name,
			async (input: unknown) => {
				try {
					const parsedInput = capability.inputSchema.parse(input);
					return await capability.handler(parsedInput, props);
				} catch (error) {
					// The RPC boundary reduces this to a message, so log while the stack exists.
					console.error(
						`ayo execute: capability "${capability.name}" failed`,
						error,
					);
					throw error;
				}
			},
		]),
	);
}

export function describeError(error: string, elapsedMs: number): string {
	return elapsedMs >= TIMEOUT_MS
		? `${error} — the script exceeded the 30s budget. Split the work.`
		: error;
}
