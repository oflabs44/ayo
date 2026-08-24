import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { searchCapabilities } from "../src/search";

const offlineEnv = { SEARCH_OFFLINE: "true" } as Env;

const goldenQueries = [
	["who am i", "whoami"],
	["what can you do", "overview"],
	["list everything you can do", "capabilities_list"],
	["show my profile", "whoami"],
	["show available tools", "capabilities_list"],
	["browse the capability registry", "capabilities_list"],
	["write this down", "notebook_write"],
	["save this note as a draft page", "notebook_write"],
	["read the brief", "notebook_read"],
	["open a notebook page", "notebook_read"],
	["show me my notes", "notebook_list"],
	["list all notebook pages", "notebook_list"],
	["recent notes", "notebook_list"],
	["delete this notebook page", "notebook_delete"],
	["remove that notebook page", "notebook_delete"],
	["what did the brief say before", "notebook_history"],
	["show the page history", "notebook_history"],
	["remember that i prefer aisle seats", "memory_remember"],
	["save my dietary preference for later", "memory_remember"],
	["what do you know about my travel preferences", "memory_recall"],
	["recall my seat preference", "memory_recall"],
	["forget what i said about aisle seats", "memory_forget"],
	["remove this fact from memory", "memory_forget"],
	["which email accounts do you have", "email_accounts"],
	["list my mail accounts", "email_accounts"],
	["find messages in my inbox", "email_search"],
	["show my starred email", "email_search"],
	["read this email thread", "email_read"],
	["show me the full message body", "email_read"],
	["compose a new email", "email_draft"],
	["prepare an email reply without sending", "email_draft"],
	["send the reviewed email draft", "email_send"],
	["deliver this draft now", "email_send"],
	["move this email to archive", "email_move"],
	["file this message in another folder", "email_move"],
	["star this email message", "email_flag"],
	["mark this message as unread", "email_flag"],
	["run a model on this text", "ai_run"],
	["classify this with an llm", "ai_run"],
	["summarize this using ai", "ai_run"],
] as const;

describe("capability search golden queries", () => {
	it.each(goldenQueries)("%s", async (query, expected) => {
		const result = await searchCapabilities(query, offlineEnv);
		if (expected === "overview") {
			expect(result).toHaveProperty("domains");
			return;
		}

		const ranked = result as { matches: Array<{ name: string }> };
		expect(ranked.matches[0]?.name).toBe(expected);
		expect(ranked).toMatchObject({ offline: true });
	});
});
