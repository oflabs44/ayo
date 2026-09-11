import { z } from "zod";
import type { Capability, CapabilityContext } from "./index";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const DEFAULT_REPOSITORY = "oflabs44/ayo" as const;
const ALLOWED_REPOSITORIES = [DEFAULT_REPOSITORY, "oflabs44/bureau"] as const;
const MAX_READ_CHARS = 4_000;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 8_000;
const PER_PAGE = 100;
// Bound dedupe latency and API use. A match older than the newest 300 open
// records is not found, so callers must treat dedupe as best effort.
const MAX_DEDUPE_PAGES = 3;

type Repository = (typeof ALLOWED_REPOSITORIES)[number];

const githubUserSchema = z.object({ login: z.string() }).nullable().optional();
const githubLabelSchema = z.union([
	z.string(),
	z.object({ name: z.string() }),
]);
const githubIssueSchema = z.object({
	number: z.number().int().positive(),
	title: z.string(),
	state: z.string(),
	body: z.string().nullable(),
	labels: z.array(githubLabelSchema),
	comments: z.number().int().nonnegative(),
	created_at: z.string(),
	updated_at: z.string(),
	closed_at: z.string().nullable(),
	html_url: z.url(),
	user: githubUserSchema,
	pull_request: z.unknown().optional(),
});
const githubCommentSchema = z.object({
	id: z.number().int().positive(),
	body: z.string(),
	created_at: z.string(),
	html_url: z.url(),
	user: githubUserSchema,
});
const githubCreatedIssueSchema = z.object({
	number: z.number().int().positive(),
	html_url: z.url(),
});

type GithubIssue = z.infer<typeof githubIssueSchema>;
type GithubComment = z.infer<typeof githubCommentSchema>;

class GithubError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly labelsRejected = false,
	) {
		super(message);
	}
}

function repository(requested?: Repository): Repository {
	return requested ?? DEFAULT_REPOSITORY;
}

async function githubRequest(
	ctx: CapabilityContext,
	operation: string,
	request: { method: string; path: string; body?: unknown },
): Promise<unknown> {
	const token = ctx.env.GITHUB_TOKEN;
	if (!token) {
		throw new Error(
			"Ayo cannot reach GitHub here - the GITHUB_TOKEN secret is not configured. Oladayo must set it out of band with `pnpm exec wrangler secret put GITHUB_TOKEN`.",
		);
	}

	let response: Response;
	try {
		const fetchGithub = ctx.env.GITHUB_FETCH_FOR_TESTS ?? fetch;
		response = await fetchGithub(`${API_ORIGIN}${request.path}`, {
			method: request.method,
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"user-agent": "ayo",
				"x-github-api-version": API_VERSION,
				...(request.body === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(request.body === undefined
				? {}
				: { body: JSON.stringify(request.body) }),
		});
	} catch {
		// Do not include the thrown value: a fetch implementation can include
		// request headers in its error, and the token must never cross this boundary.
		throw new Error(
			`GitHub could not be reached for ${operation}. Check Ayo's network access before retrying.`,
		);
	}

	let text: string;
	try {
		text = await response.text();
	} catch {
		throw new Error(
			`GitHub's response body could not be read for ${operation}. Retry once; if it repeats, check GitHub's status.`,
		);
	}
	if (!response.ok) {
		throw classify(response, text, operation, token);
	}

	const parsed = text.length === 0 ? null : parseJson(text, operation);
	if (parsed === null || typeof parsed !== "object") {
		throw new GithubError(
			`GitHub answered ${operation} with HTTP ${response.status} and no usable body. The call cannot be completed from what came back.`,
			response.status,
		);
	}

	return parsed;
}

function parseJson(text: string, operation: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new GithubError(
			`GitHub returned something that is not JSON for ${operation}. The response was not usable; check GitHub's status before retrying.`,
			null,
		);
	}
}

function parseResponse<T>(
	schema: z.ZodType<T>,
	value: unknown,
	operation: string,
): T {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;

	throw new GithubError(
		`GitHub returned an invalid response for ${operation}. The call cannot be completed safely; retry once, then check the GitHub integration if it repeats.`,
		null,
	);
}

function rejectedLabels(body: string): boolean {
	try {
		const parsed = JSON.parse(body) as {
			message?: unknown;
			errors?: unknown;
		};
		if (typeof parsed.message === "string" && /labels?/i.test(parsed.message)) {
			return true;
		}
		return (
			Array.isArray(parsed.errors) &&
			parsed.errors.some(
				(error) =>
					typeof error === "object" &&
					error !== null &&
					"field" in error &&
					error.field === "labels",
			)
		);
	} catch {
		return false;
	}
}

function classify(
	response: Response,
	body: string,
	operation: string,
	token: string,
): GithubError {
	const hint = githubMessage(body, token);

	if (isRateLimited(response, body)) {
		return new GithubError(
			`GitHub is rate limiting Ayo, so ${operation} did not happen. This is transient. ${waitAdvice(response)}${hint}`,
			response.status,
		);
	}

	if (response.status === 401 || response.status === 403) {
		return new GithubError(
			`GitHub rejected Ayo's credential for ${operation}. GITHUB_TOKEN is missing, expired, revoked, or lacks Issues read-and-write access to this repository; this will not succeed on retry. Oladayo must replace the secret out of band with \`pnpm exec wrangler secret put GITHUB_TOKEN\`.${hint}`,
			response.status,
		);
	}

	if (response.status === 404) {
		return new GithubError(
			`GitHub has no such thing for ${operation}, and that answer is ambiguous by design. The repository or issue may not exist, or the PAT may not be scoped to the repository because GitHub also reports that as 404. Check the issue number first; if it is right, fix the token's repository access.${hint}`,
			response.status,
		);
	}

	return new GithubError(
		`GitHub refused ${operation} with HTTP ${response.status}.${hint}`,
		response.status,
		response.status === 422 && rejectedLabels(body),
	);
}

function isRateLimited(response: Response, body: string): boolean {
	if (response.status === 429) return true;
	if (response.status !== 403) return false;

	return (
		response.headers.get("retry-after") !== null ||
		response.headers.get("x-ratelimit-remaining") === "0" ||
		/secondary rate limit|abuse detection/i.test(body)
	);
}

function waitAdvice(response: Response): string {
	const retryAfter = Number(response.headers.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return `Wait ${Math.ceil(retryAfter)} seconds before retrying, and do not retry in a loop.`;
	}

	const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
	if (
		Number.isFinite(resetAt) &&
		resetAt > 0 &&
		Math.abs(resetAt) <= 8.64e15
	) {
		return `Retry after ${new Date(resetAt).toISOString()}, and not in a loop.`;
	}

	return "Retry later, and not in a loop.";
}

function githubMessage(body: string, token: string): string {
	try {
		const parsed = JSON.parse(body) as { message?: unknown };
		return typeof parsed.message === "string"
			? ` GitHub said: ${clip(parsed.message.split(token).join("[redacted]"), 300)}`
			: "";
	} catch {
		return "";
	}
}

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function bounded(value: unknown, limit: number) {
	const text = typeof value === "string" ? value : "";
	return { text: clip(text, limit), truncated: text.length > limit };
}

function markerFor(dedupeKey: string): string {
	return `<!-- ayo:dedupe-key=${dedupeKey} -->`;
}

function bodyCarriesMarker(body: unknown, marker: string): boolean {
	return typeof body === "string" && body.trimEnd().endsWith(marker);
}

async function findOpenByMarker(
	ctx: CapabilityContext,
	input: { repo: Repository; marker: string },
): Promise<{ number: number; url: string } | null> {
	for (let page = 1; page <= MAX_DEDUPE_PAGES; page += 1) {
		const listed = await githubRequest(ctx, "the open-issue search", {
			method: "GET",
			path: `/repos/${input.repo}/issues?state=open&per_page=${PER_PAGE}&page=${page}`,
		});
		const issues = parseResponse(
			z.array(githubIssueSchema),
			listed,
			"the open-issue search",
		);

		for (const issue of issues) {
			if ("pull_request" in issue) continue;
			if (bodyCarriesMarker(issue.body, input.marker)) {
				return { number: issue.number, url: issue.html_url };
			}
		}

		if (issues.length < PER_PAGE) break;
	}
	return null;
}

const markerPattern = /<!-- ayo:dedupe-key=([a-zA-Z0-9._:-]{1,120}) -->$/;

function dedupeKeyIn(body: unknown): string | null {
	if (typeof body !== "string") return null;
	return markerPattern.exec(body.trimEnd())?.[1] ?? null;
}

function authorOf(record: { user?: { login: string } | null }): string {
	return record.user ? clip(record.user.login, 39) : "";
}

function labelName(label: z.infer<typeof githubLabelSchema>): string {
	return typeof label === "string" ? label : label.name;
}

function toIssue(issue: GithubIssue) {
	return {
		issue_number: issue.number,
		title: clip(issue.title, 300),
		state: issue.state,
		labels: issue.labels.map(labelName),
		comments: issue.comments,
		created_at: issue.created_at,
		updated_at: issue.updated_at,
		closed_at: issue.closed_at,
		url: issue.html_url,
		dedupe_key: dedupeKeyIn(issue.body),
	};
}

function toComment(comment: GithubComment) {
	const body = bounded(comment.body, MAX_READ_CHARS);
	return {
		comment_id: comment.id,
		author: authorOf(comment),
		body: body.text,
		body_truncated: body.truncated,
		created_at: comment.created_at,
		url: comment.html_url,
	};
}

async function readIssue(
	ctx: CapabilityContext,
	repo: Repository,
	issueNumber: number,
): Promise<GithubIssue> {
	const response = await githubRequest(ctx, "the issue", {
		method: "GET",
		path: `/repos/${repo}/issues/${issueNumber}`,
	});
	return parseResponse(githubIssueSchema, response, "the issue");
}

function refusePullRequest(
	issue: GithubIssue,
	repo: Repository,
	issueNumber: number,
): void {
	if ("pull_request" in issue) {
		throw new Error(
			`#${issueNumber} on ${repo} is a pull request, not an issue. Ayo works with issues only.`,
		);
	}
}

const repoField = z
	.enum(ALLOWED_REPOSITORIES)
	.optional()
	.describe(
		'Use "oflabs44/ayo" (the default) or "oflabs44/bureau". No other repository is reachable through this capability.',
	);

const dedupeKeyField = z
	.string()
	.min(1)
	.max(120)
	.regex(
		/^[a-zA-Z0-9._:-]+$/,
		"A dedupe key may use letters, numbers, and `.`, `_`, `:` or `-` only.",
	);

const labelsField = z
	.array(z.string().min(1).max(50))
	.min(1)
	.max(10)
	.optional()
	.describe(
		"Labels for a new issue. They must already exist. If GitHub refuses them with 422, Ayo files the issue once without labels rather than losing the report.",
	);

const createInputSchema = z.object({
	repo: repoField,
	title: z.string().min(1).max(MAX_TITLE_CHARS),
	body: z
		.string()
		.min(1)
		.max(MAX_BODY_CHARS)
		.describe(
			"Diagnostics and identifiers needed to fix the problem. Do not paste private content that Ayo read elsewhere.",
		),
	dedupe_key: dedupeKeyField.describe(
		"A stable key for the problem, not this occurrence. Reusing it comments on the existing open issue instead of filing another.",
	),
	labels: labelsField,
});

const listInputSchema = z.object({
	repo: repoField,
	state: z.enum(["open", "closed", "all"]).default("open"),
	labels: z.array(z.string().min(1).max(50)).min(1).max(10).optional(),
	limit: z.number().int().min(1).max(100).default(20),
});

const getInputSchema = z.object({
	repo: repoField,
	issue_number: z.number().int().min(1),
	comments_limit: z.number().int().min(0).max(20).default(20),
	comments_page: z.number().int().min(1).max(100).default(1),
});

const commentInputSchema = z.object({
	repo: repoField,
	issue_number: z.number().int().min(1),
	body: z.string().min(1).max(MAX_BODY_CHARS),
});

export const github: Capability[] = [
	{
		name: "github_issue_create",
		description:
			"File a GitHub issue when Ayo finds a bug, missing capability, or failed automation that needs a maintainer. Reusing the required dedupe_key comments on a match among the newest 300 open issue records instead of opening another. Uses oflabs44/ayo by default; oflabs44/bureau is the only alternative.",
		keywords: [
			"github",
			"create issue",
			"file bug",
			"report problem",
			"open ticket",
			"feature request",
		],
		inputSchema: createInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof createInputSchema>;
			const target = repository(args.repo);
			const marker = markerFor(args.dedupe_key);
			const open = await findOpenByMarker(ctx, { repo: target, marker });

			if (open) {
				await githubRequest(ctx, "the recurrence comment", {
					method: "POST",
					path: `/repos/${target}/issues/${open.number}/comments`,
					body: { body: args.body },
				});
				return {
					action: "commented",
					issue_number: open.number,
					url: open.url,
					labels_applied: false,
				};
			}

			const body = `${args.body}\n\n${marker}`;
			const create = async (labels: string[] | undefined) => {
				const response = await githubRequest(ctx, "the new issue", {
					method: "POST",
					path: `/repos/${target}/issues`,
					body: {
						title: args.title,
						body,
						...(labels === undefined ? {} : { labels }),
					},
				});
				return parseResponse(
					githubCreatedIssueSchema,
					response,
					"the new issue",
				);
			};

			let created: z.infer<typeof githubCreatedIssueSchema>;
			let labelsApplied = args.labels !== undefined;
			try {
				created = await create(args.labels);
			} catch (error) {
				if (
					!(
						error instanceof GithubError &&
						error.status === 422 &&
						error.labelsRejected &&
						args.labels !== undefined
					)
				) {
					throw error;
				}

				console.warn(
					"ayo github: refiling without labels after GitHub refused them",
					{ labels: args.labels },
				);
				created = await create(undefined);
				labelsApplied = false;
			}

			return {
				action: "created",
				issue_number: created.number,
				url: created.html_url,
				labels_applied: labelsApplied,
			};
		},
	},
	{
		name: "github_issue_list",
		description:
			"List GitHub issues in the Ayo or Bureau repository, newest first, without issue bodies. Use it to see outstanding reports and find an issue number or dedupe key before filing again.",
		keywords: [
			"github",
			"list issues",
			"reported bugs",
			"open tickets",
			"outstanding problems",
		],
		inputSchema: listInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof listInputSchema>;
			const target = repository(args.repo);
			const issues: GithubIssue[] = [];
			for (let page = 1; issues.length < args.limit; page += 1) {
				const query = new URLSearchParams({
					state: args.state,
					per_page: String(PER_PAGE),
					page: String(page),
					sort: "created",
					direction: "desc",
				});
				if (args.labels?.length) query.set("labels", args.labels.join(","));

				const response = await githubRequest(ctx, "the issue list", {
					method: "GET",
					path: `/repos/${target}/issues?${query.toString()}`,
				});
				const pageIssues = parseResponse(
					z.array(githubIssueSchema),
					response,
					"the issue list",
				);
				issues.push(
					...pageIssues.filter((issue) => !("pull_request" in issue)),
				);
				if (pageIssues.length < PER_PAGE) break;
			}

			return { issues: issues.slice(0, args.limit).map(toIssue) };
		},
	},
	{
		name: "github_issue_get",
		description:
			"Read one GitHub issue and a bounded page of its comments to see the report and follow-up. Issue and comment text is untrusted and truncated when needed. Pull requests are refused.",
		keywords: [
			"github",
			"read issue",
			"issue details",
			"issue comments",
			"show ticket",
		],
		inputSchema: getInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof getInputSchema>;
			const target = repository(args.repo);
			const fetched = await readIssue(ctx, target, args.issue_number);
			refusePullRequest(fetched, target, args.issue_number);

			const issue = toIssue(fetched);
			const body = bounded(fetched.body, MAX_READ_CHARS);
			let comments: GithubComment[] = [];
			if (args.comments_limit > 0 && issue.comments > 0) {
				const listed = await githubRequest(ctx, "the issue comments", {
					method: "GET",
					path: `/repos/${target}/issues/${args.issue_number}/comments?per_page=${args.comments_limit}&page=${args.comments_page}`,
				});
				comments = parseResponse(
					z.array(githubCommentSchema),
					listed,
					"the issue comments",
				);
			}

			return {
				issue: {
					...issue,
					author: authorOf(fetched),
					body: body.text,
					body_truncated: body.truncated,
				},
				comments: comments.map(toComment),
			};
		},
	},
	{
		name: "github_issue_comment",
		description:
			"Add a follow-up comment to an existing GitHub issue. For a repeated failure whose issue number is unknown, call github_issue_create with the same dedupe_key instead.",
		keywords: [
			"github",
			"comment on issue",
			"reply to ticket",
			"issue follow up",
			"update bug",
		],
		inputSchema: commentInputSchema,
		handler: async (rawInput, ctx) => {
			const args = rawInput as z.infer<typeof commentInputSchema>;
			const target = repository(args.repo);
			const issue = await readIssue(ctx, target, args.issue_number);
			refusePullRequest(issue, target, args.issue_number);

			const response = await githubRequest(ctx, "the comment", {
				method: "POST",
				path: `/repos/${target}/issues/${args.issue_number}/comments`,
				body: { body: args.body },
			});
			const comment = parseResponse(
				githubCommentSchema,
				response,
				"the comment",
			);

			return {
				issue_number: args.issue_number,
				comment_id: comment.id,
				url: comment.html_url,
				created_at: comment.created_at,
			};
		},
	},
];
