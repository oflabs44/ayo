import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { searchCapabilities } from "../src/search";
import { identityBodyScore } from "../src/search-support";

const offlineEnv = { SEARCH_OFFLINE: "true" } as Env;

describe("capability search", () => {
	it("counts a matched function word for less than a content word", () => {
		// Pins the weighting itself, not a ranking outcome: the end-to-end claim
		// belongs to the golden queries. Without the downweighting these two
		// scores are exactly equal.
		const query = "what are my mail folders";
		const content = identityBodyScore(
			query,
			"email_mailboxes",
			"folders",
			true,
		);
		const scaffolding = identityBodyScore(
			query,
			"email_mailboxes",
			"what",
			true,
		);

		expect(content).toBeGreaterThan(scaffolding);
	});

	it("returns a domain overview for a blank query", async () => {
		expect(await searchCapabilities("  \n", offlineEnv)).toEqual({
			domains: [
				{
					domain: "meta",
					description: "Capabilities for introspection and discovery",
					capabilities: ["whoami", "capabilities_list", "accounts_list"],
				},
				{
					domain: "notebook",
					description: "Write, read, list, and delete private notebook pages",
					capabilities: [
						"notebook_write",
						"notebook_read",
						"notebook_list",
						"notebook_delete",
						"notebook_history",
					],
				},
				{
					domain: "memory",
					description: "Remember, recall, and forget facts about the owner",
					capabilities: [
						"memory_remember",
						"memory_recall",
						"memory_forget",
					],
				},
				{
					domain: "email",
					description:
						"Manage folders and search, read, draft, send, move, and flag email",
					capabilities: [
						"email_mailboxes",
						"email_mailbox_create",
						"email_mailbox_rename",
						"email_mailbox_delete",
						"email_tags",
						"email_tag_create",
						"email_tag_update",
						"email_tag_delete",
						"email_search",
						"email_read",
						"email_draft",
						"email_send",
						"email_move",
						"email_flag",
					],
				},
				{
					domain: "calendar",
					description:
						"List calendars and read, create, update, or delete events",
					capabilities: [
						"calendar_calendars",
						"calendar_create",
						"calendar_events",
						"calendar_event_read",
						"calendar_event_create",
						"calendar_event_update",
						"calendar_event_delete",
					],
				},
				{
					domain: "tasks",
					description: "List, read, create, update, and delete tasks",
					capabilities: [
						"task_list",
						"task_read",
						"task_create",
						"task_update",
						"task_delete",
					],
				},
				{
					domain: "contacts",
					description:
						"Look up, save, and remove people in the address book",
					capabilities: [
						"contact_find",
						"contact_read",
						"contact_create",
						"contact_delete",
					],
				},
				{
					domain: "documents",
					description:
						"Search, read, update, move, trash, restore, and reprocess documents; manage folders and tags; upload and download files",
					capabilities: [
						"document_search",
						"document_read",
						"document_update",
						"document_move",
						"document_trash",
						"document_restore",
						"document_retry_processing",
						"document_correspondents",
						"document_folders",
						"document_folder_create",
						"document_folder_update",
						"document_folder_delete",
						"document_tags",
						"document_tag_create",
						"document_tag_update",
						"document_tag_delete",
						"document_tags_set",
						"document_tags_update",
						"document_upload",
						"document_file",
					],
				},
				{
					domain: "jobs",
					description:
						"Schedule, inspect, run, update, and remove unattended scripts",
					capabilities: [
						"job_event_catalog",
						"job_create",
						"job_list",
						"job_read",
						"job_update",
						"job_delete",
						"job_run_now",
					],
				},
				{
					domain: "github",
					description:
						"File, list, read, and comment on Ayo and Bureau GitHub issues",
					capabilities: [
						"github_issue_create",
						"github_issue_list",
						"github_issue_get",
						"github_issue_comment",
					],
				},
				{
					domain: "migadu",
					description:
						"Administer Migadu email hosting: onboard custom domains and create addresses and aliases",
					capabilities: [
						"migadu_domains",
						"migadu_domain_create",
						"migadu_domain_records",
						"migadu_domain_diagnostics",
						"migadu_domain_activate",
						"migadu_mailboxes",
						"migadu_mailbox_create",
						"migadu_aliases",
						"migadu_alias_create",
						"migadu_alias_delete",
					],
				},
				{
					domain: "ai",
					description:
						"Run a model to judge, classify, or summarize something",
					capabilities: ["ai_run"],
				},
			],
		});
	});

	it("returns ranked matches for a normal query", async () => {
		expect(await searchCapabilities("identity", offlineEnv)).toMatchObject({
			matches: [
				{
					name: "whoami",
					domain: "meta",
					inputSchema: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
					callExample: "await ayo.whoami({})",
				},
			],
		});
	});

	it("returns full detail for an exact entity lookup", async () => {
		expect(
			await searchCapabilities("name:capabilities_list", offlineEnv),
		).toMatchObject({
			capability: {
				name: "capabilities_list",
				domain: "meta",
				keywords: ["capabilities", "discovery", "registry", "tools"],
				callExample: "await ayo.capabilities_list({})",
			},
		});
	});

	it("exposes the Bureau event catalog and its kinds through search", async () => {
		const result = (await searchCapabilities("name:job_event_catalog", offlineEnv)) as {
			capability: { inputSchema: unknown; callExample: string };
		};
		const schema = JSON.stringify(result.capability.inputSchema);

		expect(result.capability.callExample).toBe("await ayo.job_event_catalog({})");
		expect(schema).toContain("mail.received");
		expect(schema).toContain("account.created");
		expect(schema).toContain("document.received");
	});

	it("orders matches by weighted body and identity overlap", async () => {
		const result = (await searchCapabilities(
			"capabilities caller",
			offlineEnv,
		)) as { matches: Array<{ name: string }> };

		expect(result.matches.map(({ name }) => name)).toEqual([
			"capabilities_list",
			"whoami",
			"job_create",
		]);
	});

	it("self-indexes and fuses mocked semantic results", async () => {
		const aiRun = vi.fn(
			async (_model: string, input: { text: string[] }) => ({
				data: input.text.map(() => Array<number>(384).fill(0)),
			}),
		);
		const upsert = vi.fn(async () => undefined);
		const query = vi.fn(async () => ({
			matches: [
				{ id: "capability:capabilities_list", score: 0.9 },
				{ id: "capability:whoami", score: 0.8 },
			],
		}));
		const put = vi.fn(async () => undefined);
		const onlineEnv = {
			AI: { run: aiRun },
			VECTORIZE: { upsert, query },
			OAUTH_KV: {
				get: vi.fn(async () => null),
				put,
			},
		} as unknown as Env;

		const result = (await searchCapabilities("profile", onlineEnv)) as {
			matches: Array<{ name: string }>;
		};

		expect(result.matches.map(({ name }) => name)).toEqual([
			"whoami",
			"capabilities_list",
		]);
		expect(result).not.toHaveProperty("offline");
		expect(aiRun).toHaveBeenCalledTimes(2);
		expect(aiRun).toHaveBeenNthCalledWith(
			1,
			"@cf/baai/bge-small-en-v1.5",
			{
				text: [
					expect.stringContaining("whoami\nmeta"),
					expect.stringContaining("capabilities_list\nmeta"),
					expect.stringContaining("accounts_list\nmeta"),
					expect.stringContaining("notebook_write\nnotebook"),
					expect.stringContaining("notebook_read\nnotebook"),
					expect.stringContaining("notebook_list\nnotebook"),
					expect.stringContaining("notebook_delete\nnotebook"),
					expect.stringContaining("notebook_history\nnotebook"),
					expect.stringContaining("memory_remember\nmemory"),
					expect.stringContaining("memory_recall\nmemory"),
					expect.stringContaining("memory_forget\nmemory"),
					expect.stringContaining("email_mailboxes\nemail"),
					expect.stringContaining("email_mailbox_create\nemail"),
					expect.stringContaining("email_mailbox_rename\nemail"),
					expect.stringContaining("email_mailbox_delete\nemail"),
					expect.stringContaining("email_tags\nemail"),
					expect.stringContaining("email_tag_create\nemail"),
					expect.stringContaining("email_tag_update\nemail"),
					expect.stringContaining("email_tag_delete\nemail"),
					expect.stringContaining("email_search\nemail"),
					expect.stringContaining("email_read\nemail"),
					expect.stringContaining("email_draft\nemail"),
					expect.stringContaining("email_send\nemail"),
					expect.stringContaining("email_move\nemail"),
					expect.stringContaining("email_flag\nemail"),
					expect.stringContaining("calendar_calendars\ncalendar"),
					expect.stringContaining("calendar_create\ncalendar"),
					expect.stringContaining("calendar_events\ncalendar"),
					expect.stringContaining("calendar_event_read\ncalendar"),
					expect.stringContaining("calendar_event_create\ncalendar"),
					expect.stringContaining("calendar_event_update\ncalendar"),
					expect.stringContaining("calendar_event_delete\ncalendar"),
					expect.stringContaining("task_list\ntasks"),
					expect.stringContaining("task_read\ntasks"),
					expect.stringContaining("task_create\ntasks"),
					expect.stringContaining("task_update\ntasks"),
					expect.stringContaining("task_delete\ntasks"),
					expect.stringContaining("contact_find\ncontacts"),
					expect.stringContaining("contact_read\ncontacts"),
					expect.stringContaining("contact_create\ncontacts"),
					expect.stringContaining("contact_delete\ncontacts"),
					expect.stringContaining("document_search\ndocuments"),
					expect.stringContaining("document_read\ndocuments"),
					expect.stringContaining("document_update\ndocuments"),
					expect.stringContaining("document_move\ndocuments"),
					expect.stringContaining("document_trash\ndocuments"),
					expect.stringContaining("document_restore\ndocuments"),
					expect.stringContaining("document_retry_processing\ndocuments"),
					expect.stringContaining("document_correspondents\ndocuments"),
					expect.stringContaining("document_folders\ndocuments"),
					expect.stringContaining("document_folder_create\ndocuments"),
					expect.stringContaining("document_folder_update\ndocuments"),
					expect.stringContaining("document_folder_delete\ndocuments"),
					expect.stringContaining("document_tags\ndocuments"),
					expect.stringContaining("document_tag_create\ndocuments"),
					expect.stringContaining("document_tag_update\ndocuments"),
					expect.stringContaining("document_tag_delete\ndocuments"),
					expect.stringContaining("document_tags_set\ndocuments"),
					expect.stringContaining("document_tags_update\ndocuments"),
					expect.stringContaining("document_upload\ndocuments"),
					expect.stringContaining("document_file\ndocuments"),
					expect.stringContaining("job_event_catalog\njobs"),
					expect.stringContaining("job_create\njobs"),
					expect.stringContaining("job_list\njobs"),
					expect.stringContaining("job_read\njobs"),
					expect.stringContaining("job_update\njobs"),
					expect.stringContaining("job_delete\njobs"),
					expect.stringContaining("job_run_now\njobs"),
					expect.stringContaining("github_issue_create\ngithub"),
					expect.stringContaining("github_issue_list\ngithub"),
					expect.stringContaining("github_issue_get\ngithub"),
					expect.stringContaining("github_issue_comment\ngithub"),
					expect.stringContaining("migadu_domains\nmigadu"),
					expect.stringContaining("migadu_domain_create\nmigadu"),
					expect.stringContaining("migadu_domain_records\nmigadu"),
					expect.stringContaining("migadu_domain_diagnostics\nmigadu"),
					expect.stringContaining("migadu_domain_activate\nmigadu"),
					expect.stringContaining("migadu_mailboxes\nmigadu"),
					expect.stringContaining("migadu_mailbox_create\nmigadu"),
					expect.stringContaining("migadu_aliases\nmigadu"),
					expect.stringContaining("migadu_alias_create\nmigadu"),
					expect.stringContaining("migadu_alias_delete\nmigadu"),
					expect.stringContaining("ai_run\nai"),
				],
			},
		);
		expect(aiRun).toHaveBeenNthCalledWith(
			2,
			"@cf/baai/bge-small-en-v1.5",
			{ text: ["profile"] },
		);
		expect(upsert).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "capability:whoami",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:capabilities_list",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:accounts_list",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_write",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_read",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_list",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:notebook_history",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:memory_remember",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:memory_recall",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:memory_forget",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_mailboxes",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_mailbox_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_mailbox_rename",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_mailbox_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_tags",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_tag_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_tag_update",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_tag_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_search",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_read",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_draft",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_send",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_move",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:email_flag",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:calendar_calendars",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:calendar_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:calendar_events",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:calendar_event_read",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:calendar_event_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:calendar_event_update",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:calendar_event_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:task_list",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:task_read",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:task_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:task_update",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:task_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:contact_find",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:contact_read",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:contact_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:contact_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_search",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_read",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_update",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_move",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_trash",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_restore",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_retry_processing",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_correspondents",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_folders",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_folder_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_folder_update",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_folder_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_tags",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_tag_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_tag_update",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_tag_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_tags_set",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_tags_update",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_upload",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:document_file",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:job_event_catalog",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:job_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:job_list",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:job_read",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:job_update",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:job_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:job_run_now",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:github_issue_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:github_issue_list",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:github_issue_get",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:github_issue_comment",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_domains",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_domain_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_domain_records",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_domain_diagnostics",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_domain_activate",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_mailboxes",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_mailbox_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_aliases",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_alias_create",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:migadu_alias_delete",
				namespace: "capabilities",
			}),
			expect.objectContaining({
				id: "capability:ai_run",
				namespace: "capabilities",
			}),
		]);
		expect(query).toHaveBeenCalledWith(expect.any(Array), {
			topK: 83,
			namespace: "capabilities",
		});
		expect(put).toHaveBeenCalledWith(
			"search:capabilities:content-stamp",
			expect.any(String),
		);
	});
});
