import type { Env } from "./env";

/** Confirmations expire unused after an hour; approval is an immediate act. */
const CONFIRM_TTL_SECONDS = 3_600;

function confirmKey(action: string, confirmId: string): string {
	return `confirm:${action}:${confirmId}`;
}

export async function stageConfirmation(
	env: Env,
	action: string,
	payload: unknown,
): Promise<string> {
	const confirmId = crypto.randomUUID();
	await env.OAUTH_KV.put(confirmKey(action, confirmId), JSON.stringify(payload), {
		expirationTtl: CONFIRM_TTL_SECONDS,
	});
	return confirmId;
}

export async function readConfirmation(
	env: Env,
	action: string,
	confirmId: string,
): Promise<string | null> {
	return env.OAUTH_KV.get(confirmKey(action, confirmId));
}

// Burning is tolerant: by the time a token burns, the action has happened,
// and failing the call would invite a retry that repeats it. The token
// expires on its own.
export async function burnConfirmation(
	env: Env,
	action: string,
	confirmId: string,
): Promise<void> {
	try {
		await env.OAUTH_KV.delete(confirmKey(action, confirmId));
	} catch (error) {
		console.error(`ayo ${action} confirmation cleanup failed`, error);
	}
}
