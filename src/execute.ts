import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { parse } from "acorn";
import type { Capability } from "./capabilities";
import { capabilities } from "./capabilities";
import type { Env, OwnerProps } from "./env";

const TIMEOUT_MS = 30_000;

// Codemode only unwraps a module whose sole statement is `export default`, so a
// module with helpers beside it would be wrapped verbatim and fail to parse.
// Inline the default export and call it after the rest of the module body runs.
export function inlineDefaultExport(code: string): string {
	// Same fences codemode strips, so fenced modules are inlined too.
	const source =
		code
			.trim()
			.match(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/)?.[1] ??
		code;
	let statements: ReturnType<typeof parse>["body"];
	try {
		statements = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body;
	} catch {
		return code;
	}
	const defaultExport = statements.find(
		(statement) => statement.type === "ExportDefaultDeclaration",
	);
	if (
		defaultExport?.type !== "ExportDefaultDeclaration" ||
		statements.length === 1
	) {
		return code;
	}

	const declaration = defaultExport.declaration;
	const declarationSource = source.slice(declaration.start, declaration.end);
	const namedDeclaration =
		(declaration.type === "FunctionDeclaration" ||
			declaration.type === "ClassDeclaration") &&
		declaration.id
			? declaration.id.name
			: undefined;
	const inlinedModule =
		source.slice(0, defaultExport.start) +
		(namedDeclaration ? declarationSource : "") +
		source.slice(defaultExport.end);
	const entryPoint = namedDeclaration ?? `(${declarationSource})`;

	return `async () => {\n${inlinedModule}\nreturn ${entryPoint}();\n}`;
}

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

	const executor = new DynamicWorkerExecutor({
		loader: input.env.LOADER,
		timeout: TIMEOUT_MS,
		globalOutbound: null,
	});
	const startedAt = Date.now();

	try {
		const outcome = await executor.execute(inlineDefaultExport(input.code), [
			{
				name: "ayo",
				fns: buildDispatchTable(capabilities, input.env, input.props),
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
	env: Env,
	props: OwnerProps,
): Record<string, (input: unknown) => Promise<unknown>> {
	return Object.fromEntries(
		registry.map((capability) => [
			capability.name,
			async (input: unknown) => {
				try {
					const parsedInput = capability.inputSchema.parse(input);
					return await capability.handler(parsedInput, { env, props });
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
