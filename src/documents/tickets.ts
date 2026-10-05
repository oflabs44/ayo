import type { Env } from "../env";

const TICKET_TTL_SECONDS = 5 * 60;

export type TicketKind = "upload" | "download" | "ocr";

export type UploadTicketPayload = {
	filename: string;
	mime: string;
	size: number;
	title?: string | null;
	folderId?: string | null;
};

export type DownloadTicketPayload = {
	id: string;
	variant: "original" | "preview";
};

export type OcrTicketPayload = {
	languages?: string[];
};

type TicketPayloads = {
	upload: UploadTicketPayload;
	download: DownloadTicketPayload;
	ocr: OcrTicketPayload;
};

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The token carries 256 bits of entropy, so a plain digest is enough: there is
 * no dictionary to grind and nothing cheaper than guessing the token itself.
 */
async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Mints a five-minute ticket: an opaque 256-bit token returned to the caller,
 * and only its hash stored in D1 alongside the payload the route needs.
 */
export async function createTicket<Kind extends TicketKind>(
	env: Env,
	kind: Kind,
	payload: TicketPayloads[Kind],
): Promise<{ token: string; expiresAt: string }> {
	const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const expiresAt = new Date(
		Date.now() + TICKET_TTL_SECONDS * 1_000,
	).toISOString();
	await env.JOBS_DB.prepare(
		"INSERT INTO document_tickets (token_hash, kind, payload_json, expires_at) VALUES (?1, ?2, ?3, ?4)",
	)
		.bind(await hashToken(token), kind, JSON.stringify(payload), expiresAt)
		.run();
	return { token, expiresAt };
}

/**
 * Verifies and consumes a ticket in one statement. The DELETE only matches an
 * unexpired row of the right kind and returns its payload, so two racing
 * requests cannot both win: SQLite deletes the row once, and the loser's
 * statement matches nothing. This is a real one-use guarantee.
 */
export async function consumeTicket<Kind extends TicketKind>(
	env: Env,
	kind: Kind,
	token: string,
): Promise<TicketPayloads[Kind] | null> {
	const row = await env.JOBS_DB.prepare(
		"DELETE FROM document_tickets WHERE token_hash = ?1 AND kind = ?2 AND expires_at > ?3 RETURNING payload_json",
	)
		.bind(await hashToken(token), kind, new Date().toISOString())
		.first<{ payload_json: string }>();
	return row === null ? null : (JSON.parse(row.payload_json) as TicketPayloads[Kind]);
}

export async function pruneExpiredTickets(env: Env, now: number): Promise<void> {
	await env.JOBS_DB.prepare(
		"DELETE FROM document_tickets WHERE expires_at <= ?1",
	)
		.bind(new Date(now).toISOString())
		.run();
}
