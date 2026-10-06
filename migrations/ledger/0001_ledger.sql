CREATE TABLE ledger_accounts (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
	closed_at TEXT,
	created_at TEXT NOT NULL
);

-- Entries are immutable. A correction is a second transaction that points at
-- the first through reverses_id; UNIQUE lets only one reversal win.
CREATE TABLE ledger_transactions (
	id TEXT PRIMARY KEY,
	date TEXT NOT NULL,
	payee TEXT,
	description TEXT NOT NULL,
	document_id TEXT,
	reverses_id TEXT UNIQUE REFERENCES ledger_transactions(id),
	created_at TEXT NOT NULL
);

-- amount_minor is integer cents: positive is a debit, negative is a credit.
CREATE TABLE ledger_postings (
	transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),
	account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
	amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0)
);

CREATE INDEX ledger_postings_account
	ON ledger_postings(account_id);

CREATE INDEX ledger_postings_transaction
	ON ledger_postings(transaction_id);

CREATE INDEX ledger_transactions_date
	ON ledger_transactions(date, created_at, id);
