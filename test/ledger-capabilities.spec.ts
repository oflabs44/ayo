import { env as bindings } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ledger } from "../src/capabilities/ledger";
import type { Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

type Posting = { account: string; amount: string };
type Transaction = {
	id: string;
	date: string;
	reversesId: string | null;
	reversedById: string | null;
	postings: Posting[];
};

async function createHarness() {
	const env = { LEDGER_DB: bindings.LEDGER_DB } as unknown as Env;
	const dispatch = buildDispatchTable(ledger, env, props);
	for (const [name, type] of [
		["assets:checking", "asset"],
		["liabilities:credit-card", "liability"],
		["equity:opening-balances", "equity"],
		["income:salary", "income"],
		["expenses:groceries", "expense"],
		["expenses:rent", "expense"],
	]) {
		await dispatch.ledger_account_create!({ name, type });
	}

	const record = async (
		date: string,
		description: string,
		postings: Posting[],
		payee?: string,
	) => {
		const result = (await dispatch.ledger_transaction_record!({
			date,
			description,
			payee,
			postings,
		})) as { transaction: Transaction };
		return result.transaction;
	};
	const balances = async () => {
		const result = (await dispatch.ledger_account_list!({
			includeClosed: true,
		})) as { accounts: Array<{ name: string; balance: string }> };
		return Object.fromEntries(
			result.accounts.map((account) => [account.name, account.balance]),
		);
	};
	return { env, dispatch, record, balances };
}

async function countRows(env: Env, table: string): Promise<number> {
	const row = await env.LEDGER_DB.prepare(
		`SELECT COUNT(*) AS count FROM ${table}`,
	).first<{ count: number }>();
	return row!.count;
}

describe("ledger capabilities", () => {
	it("refuses a transaction that does not sum to zero and writes nothing", async () => {
		const { env, dispatch } = await createHarness();

		await expect(
			dispatch.ledger_transaction_record!({
				date: "2026-10-01",
				description: "Groceries",
				postings: [
					{ account: "expenses:groceries", amount: "42.80" },
					{ account: "assets:checking", amount: "-42.00" },
				],
			}),
		).rejects.toThrow(/sum to zero.*0\.80/);
		expect(await countRows(env, "ledger_transactions")).toBe(0);
		expect(await countRows(env, "ledger_postings")).toBe(0);
	});

	it.each([
		["1.234", /Invalid amount/],
		["1e2", /Invalid amount/],
		["1,00", /Invalid amount/],
		["12.", /Invalid amount/],
		[".5", /Invalid amount/],
		["+1", /Invalid amount/],
		[" 1", /Invalid amount/],
		["0", /non-zero/],
		["-0.00", /non-zero/],
	])(
		"refuses the amount %j",
		async (amount, reason) => {
			const { env, dispatch } = await createHarness();

			await expect(
				dispatch.ledger_transaction_record!({
					date: "2026-10-01",
					description: "Bad amount",
					postings: [
						{ account: "expenses:groceries", amount },
						{ account: "assets:checking", amount: "-1" },
					],
				}),
			).rejects.toThrow(reason);
			expect(await countRows(env, "ledger_transactions")).toBe(0);
		},
	);

	it("keeps exact balances across whole, one-decimal, and negative amounts", async () => {
		const { record, balances } = await createHarness();

		await record("2026-10-01", "Opening balance", [
			{ account: "assets:checking", amount: "1000" },
			{ account: "equity:opening-balances", amount: "-1000" },
		]);
		await record("2026-10-02", "Groceries", [
			{ account: "expenses:groceries", amount: "0.1" },
			{ account: "expenses:groceries", amount: "0.20" },
			{ account: "assets:checking", amount: "-0.30" },
		]);
		await record("2026-10-03", "Rent on the card", [
			{ account: "expenses:rent", amount: "850.05" },
			{ account: "liabilities:credit-card", amount: "-850.05" },
		]);

		expect(await balances()).toEqual({
			"assets:checking": "999.70",
			"equity:opening-balances": "-1000.00",
			"expenses:groceries": "0.30",
			"expenses:rent": "850.05",
			"income:salary": "0.00",
			"liabilities:credit-card": "-850.05",
		});
	});

	it("reverses a transaction once and restores every balance", async () => {
		const { dispatch, record, balances } = await createHarness();
		await record("2026-10-01", "Opening balance", [
			{ account: "assets:checking", amount: "500" },
			{ account: "equity:opening-balances", amount: "-500" },
		]);
		const before = await balances();
		const wrong = await record("2026-10-02", "Groceries", [
			{ account: "expenses:groceries", amount: "42.80" },
			{ account: "assets:checking", amount: "-42.80" },
		]);

		const { transaction: reversal } =
			(await dispatch.ledger_transaction_reverse!({
				id: wrong.id,
				date: "2026-10-03",
			})) as { transaction: Transaction };

		expect(reversal.reversesId).toBe(wrong.id);
		expect(reversal.postings).toEqual([
			{ account: "expenses:groceries", amount: "-42.80" },
			{ account: "assets:checking", amount: "42.80" },
		]);
		expect(await balances()).toEqual(before);
		await expect(
			dispatch.ledger_transaction_reverse!({ id: wrong.id }),
		).rejects.toThrow(/already reversed/);
		await expect(
			dispatch.ledger_transaction_reverse!({ id: reversal.id }),
		).rejects.toThrow(/itself a reversal/);
		expect(await balances()).toEqual(before);
	});

	it("lets only one of two racing reversals win", async () => {
		const { dispatch, record, balances } = await createHarness();
		const wrong = await record("2026-10-02", "Groceries", [
			{ account: "expenses:groceries", amount: "10" },
			{ account: "assets:checking", amount: "-10" },
		]);

		const outcomes = await Promise.allSettled([
			dispatch.ledger_transaction_reverse!({ id: wrong.id }),
			dispatch.ledger_transaction_reverse!({ id: wrong.id }),
		]);

		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		expect((await balances())["assets:checking"]).toBe("0.00");
	});

	it("refuses postings to unknown and closed accounts until the account is reopened", async () => {
		const { env, dispatch, record } = await createHarness();
		const postings = [
			{ account: "expenses:rent", amount: "850" },
			{ account: "assets:checking", amount: "-850" },
		];

		await expect(
			record("2026-10-01", "Typo", [
				{ account: "expenses:rnet", amount: "850" },
				{ account: "assets:checking", amount: "-850" },
			]),
		).rejects.toThrow(/No account "expenses:rnet"/);
		await dispatch.ledger_account_update!({
			name: "expenses:rent",
			closed: true,
		});
		await expect(record("2026-10-01", "Rent", postings)).rejects.toThrow(
			/closed/,
		);
		expect(await countRows(env, "ledger_transactions")).toBe(0);

		await dispatch.ledger_account_update!({
			name: "expenses:rent",
			closed: false,
		});
		const rent = await record("2026-10-01", "Rent", postings);

		await dispatch.ledger_account_update!({
			name: "expenses:rent",
			closed: true,
		});
		await expect(
			dispatch.ledger_transaction_reverse!({ id: rent.id }),
		).rejects.toThrow(/closed/);
		await dispatch.ledger_account_update!({
			name: "expenses:rent",
			closed: false,
		});
		await expect(
			dispatch.ledger_transaction_reverse!({ id: rent.id }),
		).resolves.toMatchObject({ reversed: true });
	});

	it("refuses a reversal dated before the transaction it reverses", async () => {
		const { dispatch, record } = await createHarness();
		const wrong = await record("2026-06-01", "Groceries", [
			{ account: "expenses:groceries", amount: "10" },
			{ account: "assets:checking", amount: "-10" },
		]);

		await expect(
			dispatch.ledger_transaction_reverse!({ id: wrong.id, date: "2026-01-15" }),
		).rejects.toThrow(/before/);
	});

	it("keeps history under the new name after a rename and refuses a taken name", async () => {
		const { dispatch, record, balances } = await createHarness();
		await record("2026-10-02", "Groceries", [
			{ account: "expenses:groceries", amount: "10" },
			{ account: "assets:checking", amount: "-10" },
		]);

		await dispatch.ledger_account_update!({
			name: "expenses:groceries",
			rename: "expenses:food",
		});

		expect((await balances())["expenses:food"]).toBe("10.00");
		await expect(
			dispatch.ledger_account_update!({
				name: "expenses:food",
				rename: "expenses:rent",
			}),
		).rejects.toThrow(/already exists/);
		await expect(
			dispatch.ledger_account_create!({
				name: "expenses:food",
				type: "expense",
			}),
		).rejects.toThrow(/already exists/);
	});

	it("reports a period's income statement and a balance sheet that balances", async () => {
		const { dispatch, record } = await createHarness();
		await record("2026-08-31", "Opening balance", [
			{ account: "assets:checking", amount: "1000" },
			{ account: "equity:opening-balances", amount: "-1000" },
		]);
		await record("2026-09-15", "September groceries", [
			{ account: "expenses:groceries", amount: "100" },
			{ account: "assets:checking", amount: "-100" },
		]);
		await record("2026-10-01", "Salary", [
			{ account: "assets:checking", amount: "3000" },
			{ account: "income:salary", amount: "-3000" },
		]);
		await record("2026-10-05", "Rent on the card", [
			{ account: "expenses:rent", amount: "850" },
			{ account: "liabilities:credit-card", amount: "-850" },
		]);
		await record("2026-11-01", "November groceries", [
			{ account: "expenses:groceries", amount: "60" },
			{ account: "assets:checking", amount: "-60" },
		]);

		await expect(
			dispatch.ledger_report!({ from: "2026-10-01", to: "2026-10-31" }),
		).resolves.toEqual({
			from: "2026-10-01",
			to: "2026-10-31",
			incomeStatement: {
				income: {
					total: "3000.00",
					accounts: [{ name: "income:salary", amount: "3000.00" }],
				},
				expenses: {
					total: "850.00",
					accounts: [{ name: "expenses:rent", amount: "850.00" }],
				},
				netResult: "2150.00",
			},
			balanceSheet: {
				asOf: "2026-10-31",
				assets: {
					total: "3900.00",
					accounts: [{ name: "assets:checking", amount: "3900.00" }],
				},
				liabilities: {
					total: "850.00",
					accounts: [{ name: "liabilities:credit-card", amount: "850.00" }],
				},
				equity: {
					total: "1000.00",
					accounts: [{ name: "equity:opening-balances", amount: "1000.00" }],
				},
				accumulatedResult: "2050.00",
				netWorth: "3050.00",
				balanced: true,
			},
		});
	});

	it("searches by date, account, and text, and pages newest first without gaps", async () => {
		const { dispatch, record } = await createHarness();
		for (const day of ["01", "02", "03", "04", "05"]) {
			await record(
				`2026-10-${day}`,
				`Groceries ${day}`,
				[
					{ account: "expenses:groceries", amount: "10" },
					{ account: "assets:checking", amount: "-10" },
				],
				"Rewe",
			);
		}
		await record("2026-10-03", "Rent", [
			{ account: "expenses:rent", amount: "850" },
			{ account: "liabilities:credit-card", amount: "-850" },
		]);
		const search = (input: Record<string, unknown>) =>
			dispatch.ledger_transaction_search!(input) as Promise<{
				transactions: Array<{ description: string }>;
				nextCursor: string | null;
			}>;
		const descriptions = async (input: Record<string, unknown>) =>
			(await search(input)).transactions.map((entry) => entry.description);

		expect(
			await descriptions({ from: "2026-10-02", to: "2026-10-03" }),
		).toHaveLength(3);
		expect(await descriptions({ account: "liabilities:credit-card" })).toEqual([
			"Rent",
		]);
		expect(await descriptions({ text: "REWE", to: "2026-10-01" })).toEqual([
			"Groceries 01",
		]);
		await record(
			"2026-10-06",
			"Beitrag",
			[
				{ account: "expenses:rent", amount: "5" },
				{ account: "assets:checking", amount: "-5" },
			],
			"Ärztekammer",
		);
		expect(await descriptions({ text: "Ärzte" })).toEqual(["Beitrag"]);

		const paged: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await search({ account: "assets:checking", limit: 2, cursor });
			paged.push(...page.transactions.map((entry) => entry.description));
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		expect(paged).toEqual([
			"Beitrag",
			"Groceries 05",
			"Groceries 04",
			"Groceries 03",
			"Groceries 02",
			"Groceries 01",
		]);
	});

	it("pages through transactions booked on the same day without losing any", async () => {
		const { dispatch, record } = await createHarness();
		for (const label of ["a", "b", "c", "d", "e"]) {
			await record("2026-10-01", `Coffee ${label}`, [
				{ account: "expenses:groceries", amount: "3" },
				{ account: "assets:checking", amount: "-3" },
			]);
		}

		const paged = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = (await dispatch.ledger_transaction_search!({
				limit: 2,
				cursor,
			})) as {
				transactions: Array<{ description: string }>;
				nextCursor: string | null;
			};
			expect(page.transactions.length).toBeLessThanOrEqual(2);
			for (const entry of page.transactions) paged.add(entry.description);
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		expect(paged.size).toBe(5);
	});
});
