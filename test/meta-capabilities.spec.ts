import { describe, expect, it, vi } from "vitest";
// Importing meta.ts directly evaluates it before the registry it circularly
// imports; going through the registry keeps evaluation order correct.
import { capabilityRegistry } from "../src/capabilities/index";
import type { BureauBinding, Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const meta = capabilityRegistry.meta.capabilities;

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

describe("accounts_list", () => {
	it("lists the configured accounts through Bureau", async () => {
		const listAccounts = vi.fn(async () => [
			{ address: "oladayo@example.com", primary: true },
		]);
		const env = {
			BUREAU: { listAccounts } as unknown as BureauBinding,
		} as unknown as Env;
		const dispatch = buildDispatchTable(meta, env, props);

		await expect(dispatch.accounts_list!({})).resolves.toEqual([
			{ address: "oladayo@example.com", primary: true },
		]);
		expect(listAccounts).toHaveBeenCalledWith({});
	});

	it("reports a missing backend instead of throwing", async () => {
		const dispatch = buildDispatchTable(meta, {} as Env, props);

		await expect(dispatch.accounts_list!({})).resolves.toEqual({
			error: "The accounts backend is not configured.",
		});
	});
});
