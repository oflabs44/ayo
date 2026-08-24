import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { InMemoryNotebookStore } from "../src/notebook/memory-store";
import type { NotebookStore } from "../src/notebook/store";

const ORIGIN = "https://example.com";
const ACCESS_ISSUER_BASE =
	"https://access.example/cdn-cgi/access/sso/oidc";
const CLIENT_REDIRECT_URI = "https://client.example/callback";
const MCP_HEADERS = {
	Accept: "application/json, text/event-stream",
	"Content-Type": "application/json",
	"MCP-Protocol-Version": "2025-06-18",
};

let issuerSequence = 0;

function createTestEnv(label: string): Env {
	issuerSequence += 1;
	return {
		ACCESS_OIDC_CLIENT_ID: "access-client",
		ACCESS_OIDC_CLIENT_SECRET: "access-secret",
		ACCESS_OIDC_ISSUER: `${ACCESS_ISSUER_BASE}/${label}-${issuerSequence}`,
		OAUTH_KV: env.OAUTH_KV,
		SEARCH_OFFLINE: "true",
	} as Env;
}

function dispatch(request: Request, testEnv: Env): Promise<Response> {
	return worker.fetch(request, testEnv, createExecutionContext());
}

function mcpRequest(
	headers: Record<string, string> = {},
	method = "tools/list",
	params?: Record<string, unknown>,
): Request {
	return new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: { ...MCP_HEADERS, ...headers },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method,
			params,
		}),
	});
}

async function callTool<Result>(
	testEnv: Env,
	headers: Record<string, string>,
	name: string,
	toolArguments: Record<string, unknown>,
): Promise<{ status: number; isError?: boolean; result: Result }> {
	const response = await dispatch(
		mcpRequest(headers, "tools/call", { name, arguments: toolArguments }),
		testEnv,
	);
	const body = (await response.json()) as {
		result: { content: Array<{ text: string }>; isError?: boolean };
	};
	return {
		status: response.status,
		isError: body.result.isError,
		result: JSON.parse(body.result.content[0].text) as Result,
	};
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function registerClient(
	testEnv: Env,
	clientName = "Test MCP host",
): Promise<string> {
	const response = await dispatch(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: clientName,
				redirect_uris: [CLIENT_REDIRECT_URI],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code"],
				response_types: ["code"],
			}),
		}),
		testEnv,
	);
	const registration = (await response.json()) as { client_id: string };
	expect(response.status).toBe(201);
	return registration.client_id;
}

async function authorizationRequest(clientId: string) {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		),
	);
	const url = new URL(`${ORIGIN}/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: CLIENT_REDIRECT_URI,
		scope: "mcp",
		state: "client-state",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${ORIGIN}/mcp`,
	}).toString();
	return { url, verifier };
}

function approvalNonce(page: string): string {
	const nonce = page.match(/name="nonce" value="([^"]+)"/)?.[1];
	expect(nonce).toBeTruthy();
	return nonce!;
}

function consentCookie(response: Response): string {
	const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0];
	expect(cookie).toBeTruthy();
	return cookie!;
}

async function approve(
	page: string,
	cookie: string,
	testEnv: Env,
): Promise<Response> {
	return dispatch(
		new Request(`${ORIGIN}/authorize`, {
			method: "POST",
			headers: { Cookie: cookie },
			body: new URLSearchParams({ nonce: approvalNonce(page) }),
		}),
		testEnv,
	);
}

async function beginLogin(testEnv: Env) {
	const clientId = await registerClient(testEnv);
	const authorization = await authorizationRequest(clientId);
	const consentResponse = await dispatch(new Request(authorization.url), testEnv);
	const cookie = consentCookie(consentResponse);
	const consentPage = await consentResponse.text();
	expect(consentResponse.status).toBe(200);

	const approvalResponse = await approve(consentPage, cookie, testEnv);
	expect(approvalResponse.status).toBe(302);
	const accessLogin = new URL(approvalResponse.headers.get("Location")!);
	expect(accessLogin.origin + accessLogin.pathname).toBe(
		`${testEnv.ACCESS_OIDC_ISSUER}/authorization`,
	);

	return {
		accessLogin,
		clientId,
		cookie,
		verifier: authorization.verifier,
	};
}

type AccessTokenOptions = {
	audience?: string;
	claims?: Record<string, unknown>;
	issuer?: string;
	subject?: string | null;
	trustedKeys?: Awaited<ReturnType<typeof generateKeyPair>>;
	wrongSigningKey?: boolean;
};

async function mockAccessToken(testEnv: Env, options: AccessTokenOptions = {}) {
	const trustedKeys = options.trustedKeys ?? (await generateKeyPair("RS256"));
	const signingKeys = options.wrongSigningKey
		? await generateKeyPair("RS256")
		: trustedKeys;
	const publicJwk = await exportJWK(trustedKeys.publicKey);
	publicJwk.kid = "test-key";

	let token = new SignJWT(
		options.claims ?? {
			email: "oladayo@example.com",
			name: "Oladayo",
		},
	)
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuer(options.issuer ?? testEnv.ACCESS_OIDC_ISSUER)
		.setAudience(options.audience ?? testEnv.ACCESS_OIDC_CLIENT_ID)
		.setIssuedAt()
		.setExpirationTime("5m");
	if (options.subject !== null) {
		token = token.setSubject(options.subject ?? "ayo-owner");
	}
	const idToken = await token.sign(signingKeys.privateKey);

	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.href === `${testEnv.ACCESS_OIDC_ISSUER}/token`) {
			const body = await request.formData();
			expect(body.get("code_verifier")).toBeTruthy();
			expect(body.get("client_secret")).toBe(
				testEnv.ACCESS_OIDC_CLIENT_SECRET,
			);
			return Response.json({ id_token: idToken });
		}
		if (url.href === `${testEnv.ACCESS_OIDC_ISSUER}/jwks`) {
			return Response.json({ keys: [publicJwk] });
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});
}

async function completeLogin(
	testEnv: Env,
	accessLogin: URL,
	cookie: string,
	options: AccessTokenOptions = {},
) {
	await mockAccessToken(testEnv, options);
	const callbackUrl = new URL(`${ORIGIN}/oauth/callback`);
	callbackUrl.searchParams.set("code", "access-code");
	callbackUrl.searchParams.set("state", accessLogin.searchParams.get("state")!);
	return {
		callbackUrl,
		response: await dispatch(
			new Request(callbackUrl, { headers: { Cookie: cookie } }),
			testEnv,
		),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("OAuth-protected MCP worker", () => {
	it("rejects unauthenticated MCP requests with resource metadata", async () => {
		const testEnv = createTestEnv("unauthenticated");
		const response = await dispatch(mcpRequest(), testEnv);

		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
		);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			'scope="mcp"',
		);
	});

	it("redirects canonical notebook links to Bureau", async () => {
		const testEnv = createTestEnv("notebook-link");
		const response = await dispatch(
			new Request(`${ORIGIN}/notebook/memory/travel_preferences`),
			testEnv,
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"https://bureau.oflabs.dev/notebook/memory/travel_preferences",
		);
	});

	it.each([
		["traversal", "/notebook/memory/%2e%2e%2fsecret"],
		["invalid path", "/notebook/Memory/secret"],
	])("returns the standard 404 body for a notebook %s", async (_name, path) => {
		const response = await dispatch(
			new Request(`${ORIGIN}${path}`),
			createTestEnv(`notebook-${_name.replaceAll(" ", "-")}`),
		);

		expect(response.status).toBe(404);
		await expect(response.text()).resolves.toBe("Not found");
	});

	it("keeps the standard 404 response for other unknown routes", async () => {
		const response = await dispatch(
			new Request(`${ORIGIN}/not-a-route`),
			createTestEnv("unknown-route"),
		);

		expect(response.status).toBe(404);
		await expect(response.text()).resolves.toBe("Not found");
	});

	it("serves protected-resource and authorization-server metadata", async () => {
		const testEnv = createTestEnv("metadata");
		const resourceResponse = await dispatch(
			new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
			testEnv,
		);
		const resource = (await resourceResponse.json()) as {
			resource: string;
			authorization_servers: string[];
			scopes_supported: string[];
		};
		const serverResponse = await dispatch(
			new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
			testEnv,
		);
		const server = (await serverResponse.json()) as {
			issuer: string;
			authorization_endpoint: string;
			token_endpoint: string;
			registration_endpoint: string;
			code_challenge_methods_supported: string[];
		};

		expect(resourceResponse.status).toBe(200);
		expect(resource).toMatchObject({
			resource: `${ORIGIN}/mcp`,
			authorization_servers: [ORIGIN],
			scopes_supported: ["mcp"],
		});
		expect(serverResponse.status).toBe(200);
		expect(server).toMatchObject({
			issuer: ORIGIN,
			authorization_endpoint: `${ORIGIN}/authorize`,
			token_endpoint: `${ORIGIN}/oauth/token`,
			registration_endpoint: `${ORIGIN}/oauth/register`,
			code_challenge_methods_supported: ["S256"],
		});
	});

	it("requires approval once and rejects an invalid approval nonce", async () => {
		const testEnv = createTestEnv("approval");
		const clientId = await registerClient(testEnv);
		const firstAuthorization = await authorizationRequest(clientId);
		const consentResponse = await dispatch(
			new Request(firstAuthorization.url),
			testEnv,
		);
		const cookie = consentCookie(consentResponse);
		const consentPage = await consentResponse.text();

		expect(consentResponse.status).toBe(200);
		expect(consentPage).toContain("Test MCP host");
		expect(consentPage).toContain(CLIENT_REDIRECT_URI);
		expect(consentResponse.headers.get("Cache-Control")).toBe("no-store");
		expect(consentResponse.headers.get("Set-Cookie")).toContain(
			"Secure; HttpOnly; SameSite=Lax",
		);

		const invalidApproval = await dispatch(
			new Request(`${ORIGIN}/authorize`, {
				method: "POST",
				body: new URLSearchParams({ nonce: "bogus" }),
			}),
			testEnv,
		);
		expect(invalidApproval.status).toBe(400);

		const csrfApproval = await dispatch(
			new Request(`${ORIGIN}/authorize`, {
				method: "POST",
				body: new URLSearchParams({ nonce: approvalNonce(consentPage) }),
			}),
			testEnv,
		);
		expect(csrfApproval.status).toBe(400);

		const approvalResponse = await approve(consentPage, cookie, testEnv);
		expect(approvalResponse.status).toBe(302);
		const completed = await completeLogin(
			testEnv,
			new URL(approvalResponse.headers.get("Location")!),
			cookie,
		);
		expect(completed.response.status).toBe(302);

		const secondAuthorization = await authorizationRequest(clientId);
		const approvedResponse = await dispatch(
			new Request(secondAuthorization.url),
			testEnv,
		);
		expect(approvedResponse.status).toBe(302);
		expect(approvedResponse.headers.get("Location")).toContain(
			`${testEnv.ACCESS_OIDC_ISSUER}/authorization`,
		);
	});

	it("binds a new client approval to the consenting browser", async () => {
		const testEnv = createTestEnv("approval-browser");
		const login = await beginLogin(testEnv);
		const callbackUrl = new URL(`${ORIGIN}/oauth/callback`);
		callbackUrl.searchParams.set("code", "access-code");
		callbackUrl.searchParams.set(
			"state",
			login.accessLogin.searchParams.get("state")!,
		);

		const callbackResponse = await dispatch(new Request(callbackUrl), testEnv);
		expect(callbackResponse.status).toBe(400);

		const nextAuthorization = await authorizationRequest(login.clientId);
		const nextResponse = await dispatch(
			new Request(nextAuthorization.url),
			testEnv,
		);
		expect(nextResponse.status).toBe(200);
	});

	it("issues a token and serves MCP tools with conversation identity", async () => {
		const testEnv = createTestEnv("happy-path");
		const notebookStore = new InMemoryNotebookStore();
		await notebookStore.write("memory/aisle-seats", {
			title: "Travel preference",
			content: "I prefer aisle seats on flights.",
		});
		testEnv.NOTEBOOK_STORE_FOR_TESTS = notebookStore;
		const login = await beginLogin(testEnv);
		const completed = await completeLogin(
			testEnv,
			login.accessLogin,
			login.cookie,
		);
		const clientCallback = new URL(completed.response.headers.get("Location")!);
		expect(completed.response.status).toBe(302);
		expect(clientCallback.origin + clientCallback.pathname).toBe(
			CLIENT_REDIRECT_URI,
		);
		expect(clientCallback.searchParams.get("state")).toBe("client-state");

		const tokenResponse = await dispatch(
			new Request(`${ORIGIN}/oauth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: clientCallback.searchParams.get("code")!,
					client_id: login.clientId,
					redirect_uri: CLIENT_REDIRECT_URI,
					code_verifier: login.verifier,
					resource: `${ORIGIN}/mcp`,
				}),
			}),
			testEnv,
		);
		const token = (await tokenResponse.json()) as { access_token: string };
		expect(tokenResponse.status).toBe(200);

		const authorizationHeader = {
			Authorization: `Bearer ${token.access_token}`,
		};
		const initializeResponse = await dispatch(
			mcpRequest(authorizationHeader, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test-client", version: "1.0.0" },
			}),
			testEnv,
		);
		const initializeBody = (await initializeResponse.json()) as {
			result: { instructions?: string };
		};
		expect(initializeResponse.status).toBe(200);
		expect(initializeBody.result.instructions).toContain(
			"Ayo is your personal assistant",
		);
		expect(initializeBody.result.instructions).toContain(
			"pass it back unchanged",
		);
		expect(initializeBody.result.instructions).toContain("Do not make one up");
		expect(initializeBody.result.instructions).toContain(
			"include a brief memoryContext describing the task",
		);

		const mcpResponse = await dispatch(
			mcpRequest(authorizationHeader),
			testEnv,
		);
		const mcpBody = (await mcpResponse.json()) as {
			result: { tools: Array<{ name: string; description: string }> };
		};
		expect(mcpResponse.status).toBe(200);
		expect(mcpBody.result.tools.map(({ name }) => name)).toEqual([
			"search",
			"execute",
		]);
		expect(
			mcpBody.result.tools.every(({ description }) =>
				description.includes(
					"Optionally pass memoryContext, a brief task hint, to receive relevant remembered facts alongside the result.",
				),
			),
		).toBe(true);

		const search = await callTool<{
			conversationId: string;
			capability: {
				name: string;
				inputSchema: Record<string, unknown>;
			};
			memories: Array<{
				path: string;
				line: string;
			}>;
		}>(testEnv, authorizationHeader, "search", {
			query: "whoami",
			memoryContext: "planning travel with an aisle seat preference",
		});
		expect(search.status).toBe(200);
		expect(search.result.conversationId).toEqual(expect.any(String));
		expect(search.result.capability).toMatchObject({
			name: "whoami",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		});
		expect(search.result.memories).toEqual([
			{
				path: "memory/aisle-seats",
				line: "Travel preference — I prefer aisle seats on flights.",
			},
		]);

		const searchEcho = await callTool<{
			conversationId: string;
			memories?: unknown[];
		}>(testEnv, authorizationHeader, "search", {
			query: "whoami",
			conversationId: search.result.conversationId,
			memoryContext: "planning travel with an aisle seat preference",
		});
		expect(searchEcho.result.conversationId).toBe(
			search.result.conversationId,
		);
		expect(searchEcho.result.memories).toEqual(search.result.memories);

		const execute = await callTool<{
			conversationId: string;
			memories: Array<{ path: string }>;
		}>(testEnv, authorizationHeader, "execute", {
			code: "export default async function main() {}",
			memoryContext: "planning travel with an aisle seat preference",
		});
		expect(execute.status).toBe(200);
		expect(execute.isError).toBe(true);
		expect(execute.result).toEqual({
			conversationId: expect.any(String),
			result: null,
			logs: [],
			error:
				"The sandbox is unavailable: no LOADER binding. Capabilities cannot run.",
			memories: [
				expect.objectContaining({ path: "memory/aisle-seats" }),
			],
		});

		const executeEcho = await callTool<{
			conversationId: string;
			memories?: unknown[];
		}>(
			testEnv,
			authorizationHeader,
			"execute",
			{
				code: "export default async function main() {}",
				conversationId: execute.result.conversationId,
				memoryContext: "planning travel with an aisle seat preference",
			},
		);
		expect(executeEcho.result.conversationId).toBe(
			execute.result.conversationId,
		);
		expect(executeEcho.result.memories).toEqual([
			expect.objectContaining({ path: "memory/aisle-seats" }),
		]);

		const surfacingError = new Error("notebook unavailable");
		testEnv.NOTEBOOK_STORE_FOR_TESTS = {
			list: vi.fn(async () => {
				throw surfacingError;
			}),
		} as unknown as NotebookStore;
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const searchWithFailedSurfacing = await callTool<{
			conversationId: string;
			capability: { name: string };
			memories?: unknown[];
		}>(testEnv, authorizationHeader, "search", {
			query: "whoami",
			memoryContext: "planning travel",
		});

		expect(searchWithFailedSurfacing.result.capability.name).toBe("whoami");
		expect(searchWithFailedSurfacing.result).not.toHaveProperty("memories");
		expect(consoleError).toHaveBeenCalledWith(
			"ayo memory surfacing failed",
			surfacingError,
		);
	});

	it.each([
		["a different signing key", { wrongSigningKey: true }],
		["the wrong issuer", { issuer: `${ACCESS_ISSUER_BASE}/wrong` }],
		["the wrong audience", { audience: "wrong-client" }],
	] satisfies Array<[string, AccessTokenOptions]>)
	("rejects an ID token with %s without creating a grant", async (name, options) => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const label = name.replaceAll(" ", "-");
		const testEnv = createTestEnv(label);
		const userId = `untrusted-${label}`;
		const login = await beginLogin(testEnv);
		const completed = await completeLogin(
			testEnv,
			login.accessLogin,
			login.cookie,
			{
				...options,
				subject: userId,
			},
		);

		expect(completed.response.status).toBe(502);
		const grants = await testEnv.OAUTH_PROVIDER.listUserGrants(userId);
		expect(grants.items).toHaveLength(0);
	});

	it("rejects replayed and bogus callback state", async () => {
		const testEnv = createTestEnv("state");
		const login = await beginLogin(testEnv);
		const completed = await completeLogin(
			testEnv,
			login.accessLogin,
			login.cookie,
		);
		expect(completed.response.status).toBe(302);

		const replay = await dispatch(
			new Request(completed.callbackUrl, {
				headers: { Cookie: login.cookie },
			}),
			testEnv,
		);
		expect(replay.status).toBe(400);

		const bogusUrl = new URL(`${ORIGIN}/oauth/callback`);
		bogusUrl.searchParams.set("code", "access-code");
		bogusUrl.searchParams.set("state", "bogus");
		const bogus = await dispatch(new Request(bogusUrl), testEnv);
		expect(bogus.status).toBe(400);
	});

	it.each([
		[
			"email",
			{ claims: { name: "Oladayo" } } satisfies AccessTokenOptions,
		],
		[
			"sub",
			{
				claims: { email: "oladayo@example.com", name: "Oladayo" },
				subject: null,
			} satisfies AccessTokenOptions,
		],
	])("rejects a valid ID token missing %s", async (claim, options) => {
		const testEnv = createTestEnv(`missing-${claim}`);
		const login = await beginLogin(testEnv);
		const completed = await completeLogin(
			testEnv,
			login.accessLogin,
			login.cookie,
			options,
		);

		expect(completed.response.status).toBe(502);
	});
	it("does not persist client approval when the login fails", async () => {
		const testEnv = createTestEnv("approval-rollback");
		const login = await beginLogin(testEnv);
		const completed = await completeLogin(
			testEnv,
			login.accessLogin,
			login.cookie,
			{ wrongSigningKey: true },
		);
		expect(completed.response.status).toBe(502);

		const retry = await authorizationRequest(login.clientId);
		const consent = await dispatch(new Request(retry.url), testEnv);
		expect(consent.status).toBe(200);
		expect(await consent.text()).toContain("Approve OAuth client?");
	});

	it("escapes client-controlled values on the consent page", async () => {
		const testEnv = createTestEnv("escape");
		const clientId = await registerClient(
			testEnv,
			'<img src=x onerror=alert(1)>',
		);
		const { url } = await authorizationRequest(clientId);
		const response = await dispatch(new Request(url), testEnv);
		expect(response.status).toBe(200);
		const page = await response.text();
		expect(page).not.toContain("<img");
		expect(page).toContain("&lt;img");
	});

	it("completes login for an approved client without an approval cookie", async () => {
		const testEnv = createTestEnv("returning-client");
		const trustedKeys = await generateKeyPair("RS256");
		const login = await beginLogin(testEnv);
		const first = await completeLogin(testEnv, login.accessLogin, login.cookie, {
			trustedKeys,
		});
		expect(first.response.status).toBe(302);

		const again = await authorizationRequest(login.clientId);
		const redirect = await dispatch(new Request(again.url), testEnv);
		expect(redirect.status).toBe(302);
		const accessLogin = new URL(redirect.headers.get("Location")!);
		const second = await completeLogin(testEnv, accessLogin, "", {
			trustedKeys,
		});
		expect(second.response.status).toBe(302);
	});
});

