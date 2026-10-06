import { z } from "zod";
import {
	ACCOUNT_TYPES,
	type AccountTotals,
	type LedgerTransaction,
	accountTotals,
	createAccount,
	findAccount,
	formatAmount,
	listAccounts,
	parseAmount,
	recordTransaction,
	reverseTransaction,
	searchTransactions,
	updateAccount,
} from "../ledger/store";
import type { Capability } from "./index";

const DEFAULT_PAGE_SIZE = 20;
// Each binds one parameter per item in a single query (transaction ids per
// page, account names per transaction); D1 allows 100 per query.
const MAX_PAGE_SIZE = 50;
const MAX_POSTINGS = 50;

const accountNameSchema = z
	.string()
	.max(100)
	.regex(/^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)*$/, {
		message:
			'Use a lowercase colon path such as "expenses:groceries" or "assets:checking"',
	});
const accountTypeSchema = z.enum(ACCOUNT_TYPES);
const dateSchema = z.iso.date();
const amountSchema = z
	.string()
	.describe(
		'Decimal EUR string such as "12.34". Positive is a debit: an expense, or money arriving in an asset. Negative is a credit: income, a new debt, or money leaving an asset',
	);

const createAccountSchema = z.object({
	name: accountNameSchema,
	type: accountTypeSchema,
});
const listAccountsSchema = z.object({
	type: accountTypeSchema.optional(),
	includeClosed: z.boolean().optional(),
});
const updateAccountSchema = z
	.object({
		id: z.uuid().optional(),
		name: accountNameSchema.optional(),
		rename: accountNameSchema.optional(),
		closed: z.boolean().optional(),
	})
	.refine((input) => (input.id === undefined) !== (input.name === undefined), {
		message: "Identify the account by exactly one of id or name",
	})
	.refine((input) => input.rename !== undefined || input.closed !== undefined, {
		message: "Set rename, closed, or both",
	});
const recordTransactionSchema = z.object({
	date: dateSchema,
	description: z.string().min(1).max(500),
	payee: z.string().min(1).max(200).optional(),
	documentId: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe("Id of the receipt or invoice in the documents domain"),
	postings: z
		.array(z.object({ account: accountNameSchema, amount: amountSchema }))
		.min(2)
		.max(MAX_POSTINGS)
		.describe("The amounts must sum to zero"),
});
const reverseTransactionSchema = z.object({
	id: z.uuid(),
	date: dateSchema
		.optional()
		.describe("Defaults to today in UTC; not before the original's date"),
	description: z.string().min(1).max(500).optional(),
});
const searchTransactionsSchema = z
	.object({
		from: dateSchema.optional(),
		to: dateSchema.optional(),
		account: accountNameSchema.optional(),
		text: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe(
				"Matches the description or the payee; ignores case for ASCII letters only",
			),
		limit: z.int().min(1).max(MAX_PAGE_SIZE).optional(),
		cursor: z.string().min(1).optional(),
	})
	.refine(
		(input) =>
			input.from === undefined ||
			input.to === undefined ||
			input.from <= input.to,
		{ message: "from must not be after to" },
	);
const reportSchema = z
	.object({ from: dateSchema, to: dateSchema })
	.refine((input) => input.from <= input.to, {
		message: "from must not be after to",
	});

function presentTransaction(transaction: LedgerTransaction) {
	return {
		...transaction,
		postings: transaction.postings.map((posting) => ({
			account: posting.account,
			amount: formatAmount(posting.amountMinor),
		})),
	};
}

function section(
	totals: AccountTotals[],
	type: AccountTotals["type"],
	amountOf: (account: AccountTotals) => number,
) {
	const accounts = totals
		.filter((account) => account.type === type && amountOf(account) !== 0)
		.map((account) => ({ name: account.name, minor: amountOf(account) }));
	return {
		totalMinor: accounts.reduce((sum, account) => sum + account.minor, 0),
		accounts: accounts.map((account) => ({
			name: account.name,
			amount: formatAmount(account.minor),
		})),
	};
}

function presentSection({
	totalMinor,
	accounts,
}: ReturnType<typeof section>) {
	return { total: formatAmount(totalMinor), accounts };
}

export const ledger: Capability[] = [
	{
		name: "ledger_account_create",
		description:
			"Open a bookkeeping account in the books: a bank account, a credit card, a debt, or a spending category",
		inputSchema: createAccountSchema,
		keywords: [
			"open ledger account",
			"new spending category",
			"new income category",
			"set up bookkeeping",
		],
		handler: async (rawInput, { env }) => ({
			created: true,
			account: await createAccount(
				env,
				rawInput as z.infer<typeof createAccountSchema>,
			),
		}),
	},
	{
		name: "ledger_account_list",
		description:
			"Check how much money each bookkeeping account holds right now: bank balances, debts, and totals per spending category. Balances are signed like postings, so a debt reads negative",
		inputSchema: listAccountsSchema,
		keywords: [
			"account balances",
			"checking account balance",
			"money owed",
			"chart of accounts",
			"list ledger accounts",
		],
		handler: async (rawInput, { env }) => {
			const { type, includeClosed } = rawInput as z.infer<
				typeof listAccountsSchema
			>;
			const accounts = await listAccounts(env, {
				type,
				includeClosed: includeClosed ?? false,
			});
			return {
				accounts: accounts.map(({ balanceMinor, ...account }) => ({
					...account,
					balance: formatAmount(balanceMinor),
				})),
			};
		},
	},
	{
		name: "ledger_account_update",
		description:
			"Rename a bookkeeping account, or close one I no longer use and reopen it later",
		inputSchema: updateAccountSchema,
		keywords: [
			"rename ledger account",
			"close this account in the books",
			"reopen closed account",
			"retire spending category",
		],
		handler: async (rawInput, { env }) => {
			const { id, name, rename, closed } = rawInput as z.infer<
				typeof updateAccountSchema
			>;
			const account = await findAccount(
				env,
				id !== undefined ? { id } : { name: name! },
			);
			return {
				updated: true,
				account: await updateAccount(env, account, { name: rename, closed }),
			};
		},
	},
	{
		name: "ledger_transaction_record",
		description:
			"Record that I spent, earned, or moved money: book an expense, income, a transfer between accounts, or an opening balance in my books",
		inputSchema: recordTransactionSchema,
		keywords: [
			"i paid for groceries",
			"log an expense",
			"book this purchase",
			"record my salary",
			"transfer between accounts",
			"add a ledger entry",
			"double-entry bookkeeping",
			"accounting",
		],
		handler: async (rawInput, { env }) => {
			const { postings, ...input } = rawInput as z.infer<
				typeof recordTransactionSchema
			>;
			const transaction = await recordTransaction(env, {
				...input,
				postings: postings.map((posting) => ({
					account: posting.account,
					amountMinor: parseAmount(posting.amount),
				})),
			});
			return { recorded: true, transaction: presentTransaction(transaction) };
		},
	},
	{
		name: "ledger_transaction_reverse",
		description:
			"Undo a booked transaction that was wrong. The books are never edited: this records an opposite entry that cancels it",
		inputSchema: reverseTransactionSchema,
		keywords: [
			"that booking was a mistake",
			"cancel a ledger entry",
			"correct a wrong transaction",
			"reversal",
			"storno",
		],
		handler: async (rawInput, { env }) => {
			const { id, date, description } = rawInput as z.infer<
				typeof reverseTransactionSchema
			>;
			const reversal = await reverseTransaction(env, {
				id,
				date: date ?? new Date().toISOString().slice(0, 10),
				description,
			});
			return { reversed: true, transaction: presentTransaction(reversal) };
		},
	},
	{
		name: "ledger_transaction_search",
		description:
			"Look up what I booked: find past transactions by date range, account, payee, or words in the description",
		inputSchema: searchTransactionsSchema,
		keywords: [
			"what did i spend at rewe",
			"show recent transactions",
			"transaction history for an account",
			"find a booking",
			"ledger entries last month",
		],
		handler: async (rawInput, { env }) => {
			const { limit, ...filter } = rawInput as z.infer<
				typeof searchTransactionsSchema
			>;
			const page = await searchTransactions(env, {
				...filter,
				limit: limit ?? DEFAULT_PAGE_SIZE,
			});
			return {
				transactions: page.transactions.map(presentTransaction),
				nextCursor: page.nextCursor,
			};
		},
	},
	{
		name: "ledger_report",
		description:
			"Summarize my finances for a period: income against spending per category, what is left over, and my net worth at the end",
		inputSchema: reportSchema,
		keywords: [
			"how much did i spend this month",
			"income statement",
			"balance sheet",
			"net worth",
			"profit and loss",
			"monthly financial summary",
			"where did my money go",
		],
		handler: async (rawInput, { env }) => {
			const { from, to } = rawInput as z.infer<typeof reportSchema>;
			const totals = await accountTotals(env, from, to);
			// Stored credits are negative; income, liabilities, and equity are
			// negated so every figure reads in its natural sign.
			const income = section(totals, "income", (a) => -a.periodMinor);
			const expenses = section(totals, "expense", (a) => a.periodMinor);
			const assets = section(totals, "asset", (a) => a.balanceMinor);
			const liabilities = section(totals, "liability", (a) => -a.balanceMinor);
			const equity = section(totals, "equity", (a) => -a.balanceMinor);
			const accumulatedResultMinor = -totals
				.filter((a) => a.type === "income" || a.type === "expense")
				.reduce((sum, a) => sum + a.balanceMinor, 0);
			return {
				from,
				to,
				incomeStatement: {
					income: presentSection(income),
					expenses: presentSection(expenses),
					netResult: formatAmount(income.totalMinor - expenses.totalMinor),
				},
				balanceSheet: {
					asOf: to,
					assets: presentSection(assets),
					liabilities: presentSection(liabilities),
					equity: presentSection(equity),
					accumulatedResult: formatAmount(accumulatedResultMinor),
					netWorth: formatAmount(assets.totalMinor - liabilities.totalMinor),
					balanced:
						assets.totalMinor ===
						liabilities.totalMinor +
							equity.totalMinor +
							accumulatedResultMinor,
				},
			};
		},
	},
];
