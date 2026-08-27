import { describe, expect, it, vi } from "vitest";
import { contacts } from "../src/capabilities/contacts";
import type { BureauBinding, Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const address = "oladayo@example.com";
const contactId = "33333333-3333-4333-8333-333333333333";
const addressbook = "44444444-4444-4444-8444-444444444444";
const props: OwnerProps = {
	email: address,
	name: "Oladayo",
	sub: "ayo-owner",
};

function createHarness() {
	const staged = new Map<string, string>();
	const bureau = {
		listContacts: vi.fn(async () => []),
		getContact: vi.fn(async () => ({
			id: contactId,
			fn: "Timi Ade",
			emails: [{ value: "timi@example.com" }],
			etag: '"card-v1"',
			raw: "BEGIN:VCARD\nPHOTO;ENCODING=b:AAAA\nEND:VCARD",
		})),
		createContact: vi.fn(async () => ({
			id: contactId,
			fn: "Timi Ade",
			emails: [{ value: "timi@example.com" }],
		})),
		removeContact: vi.fn(async () => ({ id: contactId })),
	} as unknown as BureauBinding;
	const env = {
		BUREAU: bureau,
		OAUTH_KV: {
			get: vi.fn(async (key: string) => staged.get(key) ?? null),
			put: vi.fn(async (key: string, value: string) => {
				staged.set(key, value);
			}),
			delete: vi.fn(async (key: string) => {
				staged.delete(key);
			}),
		},
	} as unknown as Env;

	return { bureau, env, dispatch: buildDispatchTable(contacts, env, props) };
}

const newContact = {
	address,
	addressbook,
	fn: "Timi Ade",
	emails: [{ value: "timi@example.com" }],
};

describe("contact capabilities", () => {
	it("finds contacts with the exact Bureau RPC shape", async () => {
		const { bureau, dispatch } = createHarness();
		const input = { address, q: "timi", addressbook };

		await dispatch.contact_find!(input);

		expect(bureau.listContacts).toHaveBeenCalledWith(input);
	});

	it("reads one contact and strips the raw vCard so photos cannot leak", async () => {
		const { dispatch } = createHarness();

		const card = (await dispatch.contact_read!({
			address,
			id: contactId,
		})) as Record<string, unknown>;

		expect(card.fn).toBe("Timi Ade");
		expect(card).not.toHaveProperty("raw");
		expect(JSON.stringify(card)).not.toContain("PHOTO");
	});

	it("refuses to stage a likely duplicate by email or name", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.listContacts).mockResolvedValue([
			{
				id: contactId,
				fn: "Different Name",
				emails: [{ value: "TIMI@example.com" }],
			},
		] as never);

		const result = (await dispatch.contact_create!(newContact)) as {
			created: boolean;
			matches: Array<{ id: string }>;
			error: string;
		};

		expect(result.created).toBe(false);
		expect(result.matches).toEqual([
			expect.objectContaining({ id: contactId }),
		]);
		expect(result.error).toContain("force: true");
		expect(bureau.createContact).not.toHaveBeenCalled();
	});

	it("refuses to stage a duplicate by name when emails differ", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.listContacts).mockResolvedValue([
			{
				id: contactId,
				fn: "timi ade",
				emails: [{ value: "other@example.com" }],
			},
		] as never);

		const result = (await dispatch.contact_create!(newContact)) as {
			created: boolean;
			matches: unknown[];
		};
		expect(result.created).toBe(false);
		expect(result.matches).toHaveLength(1);
		expect(bureau.createContact).not.toHaveBeenCalled();
	});

	it("stages past the duplicate check with force and creates on confirmation", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.listContacts).mockResolvedValue([
			{
				id: contactId,
				fn: "Timi Ade",
				emails: [{ value: "timi@example.com" }],
			},
		] as never);

		const stagedResult = (await dispatch.contact_create!({
			...newContact,
			force: true,
		})) as { confirmId: string; created: boolean; preview: unknown };
		expect(stagedResult.created).toBe(false);
		expect(stagedResult.preview).toEqual(newContact);
		expect(bureau.createContact).not.toHaveBeenCalled();

		await expect(
			dispatch.contact_create!({ confirmId: stagedResult.confirmId }),
		).resolves.toEqual({
			created: true,
			contact: {
				id: contactId,
				fn: "Timi Ade",
				emails: ["timi@example.com"],
			},
		});
		expect(bureau.createContact).toHaveBeenCalledWith(newContact);
	});

	it("stages a clean create without force and refuses a reused confirmId", async () => {
		const { bureau, dispatch } = createHarness();

		const stagedResult = (await dispatch.contact_create!(newContact)) as {
			confirmId: string;
		};
		await dispatch.contact_create!({ confirmId: stagedResult.confirmId });

		const reused = (await dispatch.contact_create!({
			confirmId: stagedResult.confirmId,
		})) as { created: boolean; error: string };
		expect(reused.created).toBe(false);
		expect(reused.error).toContain("unknown or expired");
		expect(bureau.createContact).toHaveBeenCalledTimes(1);
	});

	it("previews the card before a confirmed delete", async () => {
		const { bureau, dispatch } = createHarness();

		const stagedResult = (await dispatch.contact_delete!({
			address,
			id: contactId,
		})) as { confirmId: string; deleted: boolean; preview: unknown };
		expect(stagedResult.deleted).toBe(false);
		expect(stagedResult.preview).toEqual({
			id: contactId,
			fn: "Timi Ade",
			emails: ["timi@example.com"],
		});
		expect(bureau.removeContact).not.toHaveBeenCalled();

		await expect(
			dispatch.contact_delete!({ confirmId: stagedResult.confirmId }),
		).resolves.toEqual({ deleted: true, id: contactId });
		expect(bureau.removeContact).toHaveBeenCalledWith({
			address,
			id: contactId,
			etag: '"card-v1"',
		});
	});

	it("refuses an unknown delete confirmation", async () => {
		const { bureau, dispatch } = createHarness();

		const result = (await dispatch.contact_delete!({
			confirmId: "missing",
		})) as { deleted: boolean; error: string };
		expect(result.deleted).toBe(false);
		expect(result.error).toContain("unknown or expired");
		expect(bureau.removeContact).not.toHaveBeenCalled();
	});

	it("propagates a Bureau error unchanged", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.listContacts).mockRejectedValueOnce(
			new Error("not_found: Unknown account"),
		);

		await expect(dispatch.contact_find!({ address })).rejects.toThrow(
			"Unknown account",
		);
	});
});
