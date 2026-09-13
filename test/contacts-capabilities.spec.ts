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
	const contact = {
		id: contactId,
		addressbook,
		uid: "contact-uid",
		fn: "Timi Ade",
		n: {
			family: "Ade",
			given: "Timi",
			additional: "",
			prefix: "",
			suffix: "",
		},
		nickname: "Tim",
		org: "Example Ltd",
		title: null,
		emails: [{ value: "timi@example.com" }],
		tels: [],
		urls: [],
		adrs: [],
		bday: "1990-04-12",
		anniversary: "2020-06-01",
		note: "Met at a conference",
		categories: [],
		hasPhoto: true,
		etag: '"card-v1"',
	};
	const bureau = {
		listAddressBooks: vi.fn(async () => [
			{
				id: addressbook,
				account: address,
				kind: "addressbook" as const,
				url: `https://dav.example.com/${addressbook}/`,
				displayName: "Contacts",
				color: null,
				updatedAt: "2026-09-11T20:00:00.000Z",
			},
		]),
		listContacts: vi.fn(async () => []),
		getContact: vi.fn(async () => ({
			...contact,
			raw: "BEGIN:VCARD\nPHOTO;ENCODING=b:AAAA\nEND:VCARD",
		})),
		createContact: vi.fn(async () => contact),
		updateContact: vi.fn(async () => contact),
		removeContact: vi.fn(async () => ({ id: contactId })),
	} as unknown as BureauBinding;
	const env = { BUREAU: bureau } as unknown as Env;

	return { bureau, env, dispatch: buildDispatchTable(contacts, env, props) };
}

const newContact = {
	address,
	addressbook,
	fn: "Timi Ade",
	emails: [{ value: "timi@example.com" }],
};

describe("contact capabilities", () => {
	it("lists address books with Bureau's collection shape", async () => {
		const { bureau, dispatch } = createHarness();

		await expect(dispatch.contact_addressbooks!({ address })).resolves.toEqual([
			expect.objectContaining({
				id: addressbook,
				displayName: "Contacts",
				kind: "addressbook",
			}),
		]);
		expect(bureau.listAddressBooks).toHaveBeenCalledWith({ address });
	});

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

	it("refuses a likely duplicate by email or name", async () => {
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

	it("refuses a duplicate by name when emails differ", async () => {
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

	it("creates in one call when force overrides a likely duplicate", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.listContacts).mockResolvedValue([
			{
				id: contactId,
				fn: "Timi Ade",
				emails: [{ value: "timi@example.com" }],
			},
		] as never);

		await expect(
			dispatch.contact_create!({ ...newContact, force: true }),
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

	it("patches supplied fields while preserving the rest of the contact", async () => {
		const { bureau, dispatch } = createHarness();

		await dispatch.contact_update!({
			address,
			id: contactId,
			title: "Principal Engineer",
		});

		expect(bureau.getContact).toHaveBeenCalledWith({ address, id: contactId });
		expect(bureau.updateContact).toHaveBeenCalledWith({
			address,
			id: contactId,
			etag: '"card-v1"',
			addressbook,
			fn: "Timi Ade",
			n: {
				family: "Ade",
				given: "Timi",
				additional: "",
				prefix: "",
				suffix: "",
			},
			nickname: "Tim",
			org: "Example Ltd",
			title: "Principal Engineer",
			emails: [{ value: "timi@example.com" }],
			tels: [],
			urls: [],
			adrs: [],
			bday: "1990-04-12",
			anniversary: "2020-06-01",
			note: "Met at a conference",
			categories: [],
		});
	});

	it("uses a supplied ETag and converts null to an omitted Bureau field", async () => {
		const { bureau, dispatch } = createHarness();

		await dispatch.contact_update!({
			address,
			id: contactId,
			etag: '"caller-etag"',
			nickname: null,
		});

		const update = vi.mocked(bureau.updateContact).mock.calls[0]?.[0];
		expect(update).toMatchObject({ etag: '"caller-etag"' });
		expect(update).not.toHaveProperty("nickname");
	});

	it("rejects a contact update without a contact field", async () => {
		const { bureau, dispatch } = createHarness();

		await expect(
			dispatch.contact_update!({ address, id: contactId, etag: '"card-v1"' }),
		).rejects.toThrow("At least one contact field is required");
		expect(bureau.getContact).not.toHaveBeenCalled();
		expect(bureau.updateContact).not.toHaveBeenCalled();
	});

	it("requires fn when the current contact has no formatted name", async () => {
		const { bureau, dispatch } = createHarness();
		vi.mocked(bureau.getContact).mockResolvedValueOnce({
			...(await bureau.getContact({ address, id: contactId })),
			fn: null,
		});

		await expect(
			dispatch.contact_update!({ address, id: contactId, title: "CTO" }),
		).rejects.toThrow("provide fn to update it");
		expect(bureau.updateContact).not.toHaveBeenCalled();
	});

	it("reads the current ETag and deletes the contact in one call", async () => {
		const { bureau, dispatch } = createHarness();
		const input = { address, id: contactId };

		await expect(dispatch.contact_delete!(input)).resolves.toEqual({
			deleted: true,
			id: contactId,
		});
		expect(bureau.getContact).toHaveBeenCalledWith(input);
		expect(bureau.removeContact).toHaveBeenCalledWith({
			...input,
			etag: '"card-v1"',
		});
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
