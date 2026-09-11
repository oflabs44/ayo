import { afterEach, describe, expect, it, vi } from "vitest";
import { github } from "../src/capabilities/github";
import type { Env, OwnerProps } from "../src/env";
import { buildDispatchTable } from "../src/execute";

const props: OwnerProps = {
	email: "oladayo@example.com",
	name: "Oladayo",
	sub: "ayo-owner",
};

const token = "github-secret-that-must-not-leak";
const marker = "<!-- ayo:dedupe-key=job_4:mail-unreachable -->";
const openIssue = {
	number: 12,
	title: "job_4 cannot process mail",
	state: "open",
	body: `something broke\n\n${marker}`,
	labels: [{ name: "bug" }],
	comments: 1,
	created_at: "2026-08-16T09:00:00Z",
	updated_at: "2026-08-16T10:00:00Z",
	closed_at: null,
	html_url: "https://github.com/oflabs44/ayo/issues/12",
};
const createInput = {
	title: "job_4 cannot process mail",
	body: "The mail capability was not reachable. job_id: job_4.",
	dedupe_key: "job_4:mail-unreachable",
};

type Reply = {
	status?: number;
	body: unknown;
	headers?: Record<string, string>;
};
type SentRequest = {
	url: string;
	method: string;
	headers: Headers;
	body: unknown;
};

function createHarness(replies: Reply[]) {
	const sent: SentRequest[] = [];
	const queue = [...replies];
	const githubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const rawBody = typeof init?.body === "string" ? init.body : undefined;
		sent.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: rawBody === undefined ? undefined : JSON.parse(rawBody),
		});
		const next = queue.shift() ?? {
			status: 500,
			body: { message: "No response queued" },
		};
		return new Response(
			typeof next.body === "string"
				? next.body
				: JSON.stringify(next.body),
			{
				status: next.status ?? 200,
				headers: {
					"content-type": "application/json",
					...next.headers,
				},
			},
		);
	});
	const env = {
		GITHUB_TOKEN: token,
		GITHUB_FETCH_FOR_TESTS: githubFetch as typeof fetch,
	} as unknown as Env;
	return {
		sent,
		githubFetch,
		dispatch: buildDispatchTable(github, env, props),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("github_issue_create", () => {
	it("creates in Ayo by default with the marker and current API headers", async () => {
		const { sent, dispatch } = createHarness([
			{ body: [] },
			{
				body: {
					number: 31,
					html_url: "https://github.com/oflabs44/ayo/issues/31",
				},
			},
		]);

		const result = await dispatch.github_issue_create!(createInput);

		expect(result).toEqual({
			action: "created",
			issue_number: 31,
			url: "https://github.com/oflabs44/ayo/issues/31",
			labels_applied: false,
		});
		expect(sent[0]?.url).toContain("/repos/oflabs44/ayo/issues?state=open");
		expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(sent[0]?.headers.get("x-github-api-version")).toBe("2026-03-10");
		expect(sent[1]?.body).toMatchObject({
			title: createInput.title,
			body: expect.stringMatching(new RegExp(`${marker}$`)),
		});
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("comments on the matching open issue but ignores a marked pull request", async () => {
		const pullRequest = { ...openIssue, number: 9, pull_request: { url: "x" } };
		const { sent, dispatch } = createHarness([
			{ body: [pullRequest, openIssue] },
			{ body: { id: 900 } },
		]);

		await expect(dispatch.github_issue_create!(createInput)).resolves.toEqual({
			action: "commented",
			issue_number: 12,
			url: openIssue.html_url,
			labels_applied: false,
		});
		expect(sent[1]).toMatchObject({
			url: "https://api.github.com/repos/oflabs44/ayo/issues/12/comments",
			body: { body: createInput.body },
		});
	});

	it("finds a dedupe match on the second page", async () => {
		const pullRequests = Array.from({ length: 100 }, (_, index) => ({
			...openIssue,
			number: index + 100,
			pull_request: {},
		}));
		const { sent, dispatch } = createHarness([
			{ body: pullRequests },
			{ body: [openIssue] },
			{ body: { id: 900 } },
		]);

		await expect(dispatch.github_issue_create!(createInput)).resolves.toMatchObject({
			action: "commented",
			issue_number: 12,
		});
		expect(sent[1]?.url).toContain("state=open&per_page=100&page=2");
		expect(sent).toHaveLength(3);
	});

	it("refuses a malformed dedupe response instead of creating", async () => {
		const { githubFetch, dispatch } = createHarness([{ body: {} }]);

		await expect(dispatch.github_issue_create!(createInput)).rejects.toThrow(
			"invalid response",
		);
		expect(githubFetch).toHaveBeenCalledTimes(1);
	});

	it("applies labels on a successful create", async () => {
		const { sent, dispatch } = createHarness([
			{ body: [] },
			{
				body: {
					number: 32,
					html_url: "https://github.com/oflabs44/ayo/issues/32",
				},
			},
		]);

		await expect(
			dispatch.github_issue_create!({ ...createInput, labels: ["bug"] }),
		).resolves.toMatchObject({ labels_applied: true, issue_number: 32 });
		expect(sent[1]?.body).toHaveProperty("labels", ["bug"]);
	});

	it("retries one label-specific 422 without labels", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { sent, dispatch } = createHarness([
			{ body: [] },
			{
				status: 422,
				body: {
					message: "Validation Failed",
					errors: [{ resource: "Issue", field: "labels", code: "invalid" }],
				},
			},
			{
				body: {
					number: 32,
					html_url: "https://github.com/oflabs44/ayo/issues/32",
				},
			},
		]);

		await expect(
			dispatch.github_issue_create!({ ...createInput, labels: ["missing"] }),
		).resolves.toMatchObject({ labels_applied: false, issue_number: 32 });
		expect(sent[1]?.body).toHaveProperty("labels", ["missing"]);
		expect(sent[2]?.body).not.toHaveProperty("labels");
		expect(sent).toHaveLength(3);
	});

	it("does not retry a 422 unrelated to labels", async () => {
		const { githubFetch, dispatch } = createHarness([
			{ body: [] },
			{
				status: 422,
				body: {
					message: "Validation Failed",
					errors: [{ resource: "Issue", field: "body", code: "invalid" }],
				},
			},
		]);

		await expect(
			dispatch.github_issue_create!({ ...createInput, labels: ["bug"] }),
		).rejects.toThrow("HTTP 422");
		expect(githubFetch).toHaveBeenCalledTimes(2);
	});
});

describe("repository boundary", () => {
	it("allows Bureau and rejects every other repository before fetch", async () => {
		const { sent, githubFetch, dispatch } = createHarness([{ body: [] }]);

		await dispatch.github_issue_list!({ repo: "oflabs44/bureau" });
		expect(sent[0]?.url).toContain("/repos/oflabs44/bureau/issues");

		await expect(
			dispatch.github_issue_list!({ repo: "oflabs44/other" }),
		).rejects.toThrow();
		expect(githubFetch).toHaveBeenCalledTimes(1);
	});
});

describe("GitHub failures", () => {
	it.each([
		{
			reply: { status: 401, body: { message: "Bad credentials" } },
			message: "will not succeed on retry",
		},
		{
			reply: {
				status: 403,
				body: { message: "secondary rate limit" },
				headers: { "retry-after": "60" },
			},
			message: "Wait 60 seconds",
		},
		{
			reply: { status: 404, body: { message: "Not Found" } },
			message: "ambiguous by design",
		},
	])("classifies an actionable response: $message", async ({ reply, message }) => {
		const { dispatch } = createHarness([reply]);
		await expect(dispatch.github_issue_list!({})).rejects.toThrow(message);
	});

	it("does not leak the token from a transport error", async () => {
		const githubFetch = vi.fn(async () => {
			throw new Error(token);
		});
		const env = {
			GITHUB_TOKEN: token,
			GITHUB_FETCH_FOR_TESTS: githubFetch as typeof fetch,
		} as unknown as Env;
		const dispatch = buildDispatchTable(github, env, props);

		let message = "";
		try {
			await dispatch.github_issue_list!({});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("could not be reached");
		expect(message).not.toContain(token);
	});

	it("redacts the token from a GitHub error response", async () => {
		const { dispatch } = createHarness([
			{ status: 401, body: { message: `Bad credential: ${token}` } },
		]);

		let message = "";
		try {
			await dispatch.github_issue_list!({});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("[redacted]");
		expect(message).not.toContain(token);
	});

	it("reports a missing token before fetch", async () => {
		const githubFetch = vi.fn();
		const dispatch = buildDispatchTable(
			github,
			{ GITHUB_FETCH_FOR_TESTS: githubFetch as typeof fetch } as Env,
			props,
		);

		await expect(dispatch.github_issue_list!({})).rejects.toThrow(
			"GITHUB_TOKEN secret is not configured",
		);
		expect(githubFetch).not.toHaveBeenCalled();
	});
});

describe("issue reads", () => {
	it("filters pull requests and projects list records without bodies", async () => {
		const { dispatch } = createHarness([
			{
				body: [
					{
						...openIssue,
						user: { login: "oflabs44", avatar_url: "private" },
						reactions: { "+1": 1 },
					},
					{ ...openIssue, number: 13, pull_request: {} },
				],
			},
		]);

		const result = (await dispatch.github_issue_list!({})) as {
			issues: Array<Record<string, unknown>>;
		};
		expect(result.issues).toEqual([
			{
				issue_number: 12,
				title: openIssue.title,
				state: "open",
				labels: ["bug"],
				comments: 1,
				created_at: openIssue.created_at,
				updated_at: openIssue.updated_at,
				closed_at: null,
				url: openIssue.html_url,
				dedupe_key: "job_4:mail-unreachable",
			},
		]);
		expect(JSON.stringify(result)).not.toContain("something broke");
		expect(JSON.stringify(result)).not.toContain("avatar_url");
	});

	it("paginates past pull requests to satisfy the issue limit", async () => {
		const pullRequests = Array.from({ length: 100 }, (_, index) => ({
			...openIssue,
			number: index + 100,
			pull_request: {},
		}));
		const { sent, dispatch } = createHarness([
			{ body: pullRequests },
			{ body: [openIssue] },
		]);

		const result = (await dispatch.github_issue_list!({ limit: 1 })) as {
			issues: Array<{ issue_number: number }>;
		};
		expect(result.issues).toEqual([expect.objectContaining({ issue_number: 12 })]);
		expect(sent[1]?.url).toContain("per_page=100&page=2");
	});

	it("bounds issue and comment text and sends the requested comment page", async () => {
		const longBody = "x".repeat(10_000);
		const { sent, dispatch } = createHarness([
			{ body: { ...openIssue, body: longBody, user: { login: "oflabs44" } } },
			{
				body: [
					{
						id: 900,
						body: longBody,
						created_at: "2026-08-17T09:00:00Z",
						html_url: `${openIssue.html_url}#issuecomment-900`,
						user: { login: "ayo" },
					},
				],
			},
		]);

		const result = (await dispatch.github_issue_get!({
			issue_number: 12,
			comments_limit: 5,
			comments_page: 3,
		})) as {
			issue: { body: string; body_truncated: boolean };
			comments: Array<{ body: string; body_truncated: boolean }>;
		};
		expect(sent[1]?.url).toContain("comments?per_page=5&page=3");
		expect(result.issue).toMatchObject({ body_truncated: true });
		expect(result.issue.body.length).toBeLessThan(longBody.length);
		expect(result.comments[0]).toMatchObject({ body_truncated: true });
	});

	it("refuses pull requests before reading comments and bounds pagination", async () => {
		const { githubFetch, dispatch } = createHarness([
			{ body: { ...openIssue, pull_request: {} } },
		]);
		await expect(
			dispatch.github_issue_get!({ issue_number: 12 }),
		).rejects.toThrow("pull request");
		expect(githubFetch).toHaveBeenCalledTimes(1);

		await expect(
			dispatch.github_issue_get!({ issue_number: 12, comments_limit: 21 }),
		).rejects.toThrow();
		await expect(
			dispatch.github_issue_get!({ issue_number: 12, comments_page: 101 }),
		).rejects.toThrow();
		expect(githubFetch).toHaveBeenCalledTimes(1);
	});
});

describe("github_issue_comment", () => {
	it("posts a comment and returns only its bounded projection", async () => {
		const { sent, dispatch } = createHarness([
			{ body: openIssue },
			{
				body: {
					id: 900,
					html_url: `${openIssue.html_url}#issuecomment-900`,
					created_at: "2026-08-17T09:00:00Z",
					body: "echoed",
					user: { login: "ayo", token },
				},
			},
		]);

		const result = await dispatch.github_issue_comment!({
			issue_number: 12,
			body: "Still failing",
		});
		expect(sent[0]?.url).toBe(
			"https://api.github.com/repos/oflabs44/ayo/issues/12",
		);
		expect(sent[1]).toMatchObject({
			url: "https://api.github.com/repos/oflabs44/ayo/issues/12/comments",
			body: { body: "Still failing" },
		});
		expect(result).toEqual({
			issue_number: 12,
			comment_id: 900,
			url: `${openIssue.html_url}#issuecomment-900`,
			created_at: "2026-08-17T09:00:00Z",
		});
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("refuses to comment on a pull request", async () => {
		const { githubFetch, dispatch } = createHarness([
			{ body: { ...openIssue, pull_request: {} } },
		]);

		await expect(
			dispatch.github_issue_comment!({
				issue_number: 12,
				body: "Still failing",
			}),
		).rejects.toThrow("pull request");
		expect(githubFetch).toHaveBeenCalledTimes(1);
	});
});
