-- Single-use tickets for the unauthenticated document upload and download
-- routes. Only the token's SHA-256 lives here, so a database read cannot
-- reconstruct a usable link.
CREATE TABLE document_tickets (
	token_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('upload', 'download')),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
	expires_at TEXT NOT NULL
);

CREATE INDEX document_tickets_expires_at
	ON document_tickets(expires_at);
