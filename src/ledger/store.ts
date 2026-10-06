import type { Env } from "../env";

export const ACCOUNT_TYPES = [
	"asset",
	"liability",
	"equity",
	"income",
	"expense",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type LedgerAccount = {
	id: string;
	name: string;
	type: AccountType;
	closedAt: string | null;
	createdAt: string;
};

/** Minor units are integer cents: positive is a debit, negative is a credit. */
export type LedgerPosting = { account: string; amountMinor: number };

export type LedgerTransaction = {
	id: string;
	date: string;
	payee: string | null;
	description: string;
	documentId: string | null;
	reversesId: string | null;
	reversedById: string | null;
	createdAt: string;
	postings: LedgerPosting[];
};

export type AccountTotals = {
	name: string;
	type: AccountType;
	balanceMinor: number;
	periodMinor: number;
};

type StoredAccount = {
	id: string;
	name: string;
	type: AccountType;
	closed_at: string | null;
	created_at: string;
};

type StoredTransaction = {
	id: string;
	date: string;
	payee: string | null;
	description: string;
	document_id: string | null;
	reverses_id: string | null;
	reversed_by_id: string | null;
	created_at: string;
};

// Eleven integer digits keep one amount, and the sum of one transaction's
// postings, far inside the safe integer range.
const AMOUNT_PATTERN = /^(-?)(\d{1,11})(?:\.(\d{1,2}))?$/;

export function parseAmount(amount: string): number {
	const match = AMOUNT_PATTERN.exec(amount);
	if (!match) {
		throw new Error(
			`Invalid amount "${amount}". Use a decimal EUR string such as "12.34" or "-0.50": at most two decimals, no exponent, and no thousands separators.`,
		);
	}
	const cents =
		Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
	return match[1] === "-" ? -cents : cents;
}

export function formatAmount(amountMinor: number): string {
	const absolute = Math.abs(amountMinor);
	const cents = String(absolute % 100).padStart(2, "0");
	return `${amountMinor < 0 ? "-" : ""}${Math.trunc(absolute / 100)}.${cents}`;
}

function fromStoredAccount(row: StoredAccount): LedgerAccount {
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		closedAt: row.closed_at,
		createdAt: row.created_at,
	};
}

function placeholders(count: number): string {
	return Array.from({ length: count }, (_, index) => `?${index + 1}`).join(", ");
}

function noAccount(reference: string): Error {
	return new Error(
		`No account "${reference}". Use ledger_account_list to see the accounts, or ledger_account_create to add it.`,
	);
}

function closedAccount(name: string): Error {
	return new Error(
		`Account "${name}" is closed. Reopen it with ledger_account_update, or post to another account.`,
	);
}

function alreadyReversed(id: string, reversalId: string): Error {
	return new Error(
		`Transaction "${id}" is already reversed by "${reversalId}". A transaction can be reversed only once; record a new transaction instead.`,
	);
}

function accountExists(name: string): Error {
	return new Error(`An account named "${name}" already exists.`);
}

export async function findAccount(
	env: Env,
	reference: { id: string } | { name: string },
): Promise<LedgerAccount> {
	const [column, value] =
		"id" in reference ? ["id", reference.id] : ["name", reference.name];
	const row = await env.LEDGER_DB.prepare(
		`SELECT * FROM ledger_accounts WHERE ${column} = ?1`,
	)
		.bind(value)
		.first<StoredAccount>();
	if (row === null) throw noAccount(value);
	return fromStoredAccount(row);
}

async function accountNameTaken(env: Env, name: string): Promise<boolean> {
	const row = await env.LEDGER_DB.prepare(
		"SELECT 1 FROM ledger_accounts WHERE name = ?1",
	)
		.bind(name)
		.first();
	return row !== null;
}

export async function createAccount(
	env: Env,
	input: { name: string; type: AccountType },
): Promise<LedgerAccount> {
	if (await accountNameTaken(env, input.name)) throw accountExists(input.name);
	const account: LedgerAccount = {
		id: crypto.randomUUID(),
		name: input.name,
		type: input.type,
		closedAt: null,
		createdAt: new Date().toISOString(),
	};
	await env.LEDGER_DB.prepare(
		`INSERT INTO ledger_accounts (id, name, type, closed_at, created_at)
		VALUES (?1, ?2, ?3, NULL, ?4)`,
	)
		.bind(account.id, account.name, account.type, account.createdAt)
		.run();
	return account;
}

export async function updateAccount(
	env: Env,
	account: LedgerAccount,
	changes: { name?: string; closed?: boolean },
): Promise<LedgerAccount> {
	const name = changes.name ?? account.name;
	if (name !== account.name && (await accountNameTaken(env, name))) {
		throw accountExists(name);
	}
	let closedAt = account.closedAt;
	if (changes.closed === false) closedAt = null;
	if (changes.closed === true) closedAt ??= new Date().toISOString();
	await env.LEDGER_DB.prepare(
		"UPDATE ledger_accounts SET name = ?2, closed_at = ?3 WHERE id = ?1",
	)
		.bind(account.id, name, closedAt)
		.run();
	return { ...account, name, closedAt };
}

export async function listAccounts(
	env: Env,
	filter: { type?: AccountType; includeClosed: boolean },
): Promise<Array<LedgerAccount & { balanceMinor: number }>> {
	const { results } = await env.LEDGER_DB.prepare(
		`SELECT a.*, COALESCE(SUM(p.amount_minor), 0) AS balance_minor
		FROM ledger_accounts a
		LEFT JOIN ledger_postings p ON p.account_id = a.id
		WHERE (?1 IS NULL OR a.type = ?1)
			AND (?2 = 1 OR a.closed_at IS NULL)
		GROUP BY a.id
		ORDER BY a.name`,
	)
		.bind(filter.type ?? null, filter.includeClosed ? 1 : 0)
		.all<StoredAccount & { balance_minor: number }>();
	return results.map((row) => ({
		...fromStoredAccount(row),
		balanceMinor: row.balance_minor,
	}));
}

async function attachPostings(
	env: Env,
	rows: StoredTransaction[],
): Promise<LedgerTransaction[]> {
	const postingsByTransaction = new Map<string, LedgerPosting[]>();
	if (rows.length > 0) {
		const { results } = await env.LEDGER_DB.prepare(
			`SELECT p.transaction_id, a.name AS account, p.amount_minor
			FROM ledger_postings p
			JOIN ledger_accounts a ON a.id = p.account_id
			WHERE p.transaction_id IN (${placeholders(rows.length)})
			ORDER BY p.rowid`,
		)
			.bind(...rows.map((row) => row.id))
			.all<{ transaction_id: string; account: string; amount_minor: number }>();
		for (const posting of results) {
			const postings = postingsByTransaction.get(posting.transaction_id) ?? [];
			postings.push({
				account: posting.account,
				amountMinor: posting.amount_minor,
			});
			postingsByTransaction.set(posting.transaction_id, postings);
		}
	}
	return rows.map((row) => ({
		id: row.id,
		date: row.date,
		payee: row.payee,
		description: row.description,
		documentId: row.document_id,
		reversesId: row.reverses_id,
		reversedById: row.reversed_by_id,
		createdAt: row.created_at,
		postings: postingsByTransaction.get(row.id) ?? [],
	}));
}

async function selectTransactions(
	env: Env,
	where: string,
	binds: unknown[],
	limit: number,
): Promise<StoredTransaction[]> {
	const { results } = await env.LEDGER_DB.prepare(
		`SELECT t.*, r.id AS reversed_by_id
		FROM ledger_transactions t
		LEFT JOIN ledger_transactions r ON r.reverses_id = t.id
		WHERE ${where}
		ORDER BY t.date DESC, t.created_at DESC, t.id DESC
		LIMIT ?${binds.length + 1}`,
	)
		.bind(...binds, limit)
		.all<StoredTransaction>();
	return results;
}

async function findTransactionRow(
	env: Env,
	id: string,
): Promise<StoredTransaction> {
	const [row] = await selectTransactions(env, "t.id = ?1", [id], 1);
	if (row === undefined) {
		throw new Error(
			`No transaction "${id}". Use ledger_transaction_search to find it.`,
		);
	}
	return row;
}

async function getTransaction(env: Env, id: string): Promise<LedgerTransaction> {
	const [transaction] = await attachPostings(env, [
		await findTransactionRow(env, id),
	]);
	return transaction!;
}

export async function recordTransaction(
	env: Env,
	input: {
		date: string;
		description: string;
		payee?: string;
		documentId?: string;
		postings: LedgerPosting[];
	},
): Promise<LedgerTransaction> {
	if (input.postings.length < 2) {
		throw new Error("A transaction needs at least two postings.");
	}
	let sum = 0;
	for (const posting of input.postings) {
		if (!Number.isSafeInteger(posting.amountMinor) || posting.amountMinor === 0) {
			throw new Error(
				`The amount posted to "${posting.account}" must be a non-zero amount of whole cents.`,
			);
		}
		sum += posting.amountMinor;
	}
	if (sum !== 0) {
		throw new Error(
			`The postings must sum to zero (debits positive, credits negative); these sum to ${formatAmount(sum)}. Nothing was recorded.`,
		);
	}

	const names = [...new Set(input.postings.map((posting) => posting.account))];
	const { results } = await env.LEDGER_DB.prepare(
		`SELECT * FROM ledger_accounts WHERE name IN (${placeholders(names.length)})`,
	)
		.bind(...names)
		.all<StoredAccount>();
	const accountsByName = new Map(results.map((row) => [row.name, row]));
	for (const name of names) {
		const account = accountsByName.get(name);
		if (account === undefined) throw noAccount(name);
		if (account.closed_at !== null) throw closedAccount(name);
	}

	const id = crypto.randomUUID();
	const createdAt = new Date().toISOString();
	// One batch is one SQL transaction: a failed statement rolls all of it back.
	await env.LEDGER_DB.batch([
		env.LEDGER_DB.prepare(
			`INSERT INTO ledger_transactions (
				id, date, payee, description, document_id, reverses_id, created_at
			) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`,
		).bind(
			id,
			input.date,
			input.payee ?? null,
			input.description,
			input.documentId ?? null,
			createdAt,
		),
		...input.postings.map((posting) =>
			env.LEDGER_DB.prepare(
				`INSERT INTO ledger_postings (transaction_id, account_id, amount_minor)
				VALUES (?1, ?2, ?3)`,
			).bind(id, accountsByName.get(posting.account)!.id, posting.amountMinor),
		),
	]);
	// Built from memory, not read back: a failed read after the commit would
	// report an error for a booked transaction, and the retry would book it twice.
	return {
		id,
		date: input.date,
		payee: input.payee ?? null,
		description: input.description,
		documentId: input.documentId ?? null,
		reversesId: null,
		reversedById: null,
		createdAt,
		postings: input.postings,
	};
}

export async function reverseTransaction(
	env: Env,
	input: { id: string; date: string; description?: string },
): Promise<LedgerTransaction> {
	const original = await findTransactionRow(env, input.id);
	if (original.reverses_id !== null) {
		throw new Error(
			`Transaction "${input.id}" is itself a reversal and cannot be reversed. Record a new transaction instead.`,
		);
	}
	if (original.reversed_by_id !== null) {
		throw alreadyReversed(input.id, original.reversed_by_id);
	}
	if (input.date < original.date) {
		throw new Error(
			`A reversal cannot be dated ${input.date}, before the ${original.date} transaction it reverses: a report for the time between them would count the reversal alone.`,
		);
	}
	const closed = await env.LEDGER_DB.prepare(
		`SELECT a.name FROM ledger_postings p
		JOIN ledger_accounts a ON a.id = p.account_id
		WHERE p.transaction_id = ?1 AND a.closed_at IS NOT NULL
		LIMIT 1`,
	)
		.bind(input.id)
		.first<{ name: string }>();
	if (closed !== null) throw closedAccount(closed.name);

	const reversalId = crypto.randomUUID();
	try {
		await env.LEDGER_DB.batch([
			env.LEDGER_DB.prepare(
				`INSERT INTO ledger_transactions (
					id, date, payee, description, document_id, reverses_id, created_at
				) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
			).bind(
				reversalId,
				input.date,
				original.payee,
				input.description ?? `Reversal of: ${original.description}`,
				original.document_id,
				input.id,
				new Date().toISOString(),
			),
			env.LEDGER_DB.prepare(
				`INSERT INTO ledger_postings (transaction_id, account_id, amount_minor)
				SELECT ?1, account_id, -amount_minor
				FROM ledger_postings
				WHERE transaction_id = ?2
				ORDER BY rowid`,
			).bind(reversalId, input.id),
		]);
	} catch (error) {
		// Two racing reversals both pass the check above; the UNIQUE constraint
		// on reverses_id lets one win, and the loser lands here.
		const winner = await env.LEDGER_DB.prepare(
			"SELECT id FROM ledger_transactions WHERE reverses_id = ?1",
		)
			.bind(input.id)
			.first<{ id: string }>();
		if (winner === null) throw error;
		if (winner.id !== reversalId) throw alreadyReversed(input.id, winner.id);
	}
	return getTransaction(env, reversalId);
}

export async function searchTransactions(
	env: Env,
	filter: {
		from?: string;
		to?: string;
		account?: string;
		text?: string;
		limit: number;
		cursor?: string;
	},
): Promise<{ transactions: LedgerTransaction[]; nextCursor: string | null }> {
	const conditions = ["1 = 1"];
	const binds: unknown[] = [];
	const bind = (value: unknown) => {
		binds.push(value);
		return `?${binds.length}`;
	};
	if (filter.from !== undefined) {
		conditions.push(`t.date >= ${bind(filter.from)}`);
	}
	if (filter.to !== undefined) conditions.push(`t.date <= ${bind(filter.to)}`);
	if (filter.account !== undefined) {
		const account = await findAccount(env, { name: filter.account });
		conditions.push(
			`EXISTS (
				SELECT 1 FROM ledger_postings p
				WHERE p.transaction_id = t.id AND p.account_id = ${bind(account.id)}
			)`,
		);
	}
	if (filter.text !== undefined) {
		// instr, not LIKE: D1 caps a LIKE pattern at 50 bytes. Both sides fold
		// in SQLite, whose lower() is ASCII-only: folding the needle in JS would
		// lowercase "Ä" and then miss the stored "Ä".
		const needle = bind(filter.text);
		conditions.push(
			`(instr(lower(t.description), lower(${needle})) > 0
				OR instr(lower(COALESCE(t.payee, '')), lower(${needle})) > 0)`,
		);
	}
	if (filter.cursor !== undefined) {
		const parts = filter.cursor.split("|");
		if (parts.length !== 3) {
			throw new Error(
				"Invalid cursor. Pass the nextCursor of the previous page unchanged.",
			);
		}
		conditions.push(
			`(t.date, t.created_at, t.id) < (${bind(parts[0])}, ${bind(parts[1])}, ${bind(parts[2])})`,
		);
	}

	const rows = await selectTransactions(
		env,
		conditions.join(" AND "),
		binds,
		filter.limit + 1,
	);
	const page = rows.slice(0, filter.limit);
	const last = page.at(-1);
	return {
		transactions: await attachPostings(env, page),
		nextCursor:
			rows.length > filter.limit && last !== undefined
				? `${last.date}|${last.created_at}|${last.id}`
				: null,
	};
}

/** Per-account totals up to `to`; `periodMinor` counts only `from` onward. */
export async function accountTotals(
	env: Env,
	from: string,
	to: string,
): Promise<AccountTotals[]> {
	const { results } = await env.LEDGER_DB.prepare(
		`SELECT a.name, a.type,
			SUM(p.amount_minor) AS balance_minor,
			SUM(CASE WHEN t.date >= ?1 THEN p.amount_minor ELSE 0 END) AS period_minor
		FROM ledger_postings p
		JOIN ledger_accounts a ON a.id = p.account_id
		JOIN ledger_transactions t ON t.id = p.transaction_id
		WHERE t.date <= ?2
		GROUP BY a.id
		ORDER BY a.name`,
	)
		.bind(from, to)
		.all<{
			name: string;
			type: AccountType;
			balance_minor: number;
			period_minor: number;
		}>();
	return results.map((row) => ({
		name: row.name,
		type: row.type,
		balanceMinor: row.balance_minor,
		periodMinor: row.period_minor,
	}));
}
