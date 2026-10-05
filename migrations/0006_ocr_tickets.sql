-- Adds the 'ocr' ticket kind. SQLite cannot alter a CHECK constraint, so the
-- table is rebuilt; tickets live five minutes, so no row is worth carrying
-- over.
DROP TABLE document_tickets;

CREATE TABLE document_tickets (
	token_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('upload', 'download', 'ocr')),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
	expires_at TEXT NOT NULL
);

CREATE INDEX document_tickets_expires_at
	ON document_tickets(expires_at);
