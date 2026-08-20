import type { Env } from "./env";

/** Suppression entries expire six hours after they are surfaced. */
export const SUPPRESSION_TTL_SECONDS = 6 * 60 * 60;

function suppressionKey(conversationId: string, key: string): string {
	// Encoded segments so a colon-bearing host-supplied id can never make two
	// distinct (conversation, key) pairs collide on one KV key.
	return `suppress:${encodeURIComponent(conversationId)}:${encodeURIComponent(key)}`;
}

export function mintConversationId(): string {
	return crypto.randomUUID();
}

export async function alreadySurfaced(
	env: Env,
	conversationId: string,
	key: string,
): Promise<boolean> {
	return (await env.OAUTH_KV.get(suppressionKey(conversationId, key))) !== null;
}

export async function markSurfaced(
	env: Env,
	conversationId: string,
	keys: string[],
): Promise<void> {
	await Promise.all(
		keys.map((key) =>
			env.OAUTH_KV.put(suppressionKey(conversationId, key), "1", {
				expirationTtl: SUPPRESSION_TTL_SECONDS,
			}),
		),
	);
}
