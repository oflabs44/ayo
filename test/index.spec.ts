import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

const ORIGIN = "https://example.com";
const ACCESS_ISSUER =
	"https://access.example/cdn-cgi/access/sso/oidc/access-client";
const CLIENT_REDIRECT_URI = "https://client.example/callback";
const MCP_HEADERS = {
	Accept: "application/json, text/event-stream",
	"Content-Type": "application/json",
	"MCP-Protocol-Version": "2025-06-18",
};

const testEnv = {
	ACCESS_OIDC_CLIENT_ID: "access-client",
	ACCESS_OIDC_CLIENT_SECRET: "access-secret",
	ACCESS_OIDC_ISSUER: ACCESS_ISSUER,
	OAUTH_KV: env.OAUTH_KV,
} as Env;

function dispatch(request: Request): Promise<Response> {
	return worker.fetch(request, testEnv, createExecutionContext());
}

function mcpRequest(headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: { ...MCP_HEADERS, ...headers },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		}),
	});
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

afterEach(() => vi.restoreAllMocks());

describe("OAuth-protected MCP worker", () => {
	it("rejects unauthenticated MCP requests with resource metadata", async () => {
		const response = await dispatch(mcpRequest());

		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
		);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			'scope="mcp"',
		);
	});

	it("serves protected-resource and authorization-server metadata", async () => {
		const resourceResponse = await dispatch(
			new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
		);
		const resource = (await resourceResponse.json()) as {
			resource: string;
			authorization_servers: string[];
			scopes_supported: string[];
		};
		const serverResponse = await dispatch(
			new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
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

	it("issues a token after Access OIDC login and accepts it at MCP", async () => {
		const registrationResponse = await dispatch(
			new Request(`${ORIGIN}/oauth/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_name: "Test MCP host",
					redirect_uris: [CLIENT_REDIRECT_URI],
					token_endpoint_auth_method: "none",
					grant_types: ["authorization_code"],
					response_types: ["code"],
				}),
			}),
		);
		const registration = (await registrationResponse.json()) as {
			client_id: string;
		};
		expect(registrationResponse.status).toBe(201);

		const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = base64url(
			new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
			),
		);
		const authorizeUrl = new URL(`${ORIGIN}/authorize`);
		authorizeUrl.search = new URLSearchParams({
			response_type: "code",
			client_id: registration.client_id,
			redirect_uri: CLIENT_REDIRECT_URI,
			scope: "mcp",
			state: "client-state",
			code_challenge: challenge,
			code_challenge_method: "S256",
			resource: `${ORIGIN}/mcp`,
		}).toString();

		const authorizeResponse = await dispatch(new Request(authorizeUrl));
		const accessLogin = new URL(authorizeResponse.headers.get("Location")!);
		expect(authorizeResponse.status).toBe(302);
		expect(accessLogin.origin + accessLogin.pathname).toBe(
			`${ACCESS_ISSUER}/authorization`,
		);

		const { publicKey, privateKey } = await generateKeyPair("RS256");
		const publicJwk = await exportJWK(publicKey);
		publicJwk.kid = "test-key";
		const idToken = await new SignJWT({
			email: "oladayo@example.com",
			name: "Oladayo",
		})
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer(ACCESS_ISSUER)
			.setAudience(testEnv.ACCESS_OIDC_CLIENT_ID)
			.setSubject("ayo-owner")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.href === `${ACCESS_ISSUER}/token`) {
				return Response.json({ id_token: idToken });
			}
			if (url.href === `${ACCESS_ISSUER}/jwks`) {
				return Response.json({ keys: [publicJwk] });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const callbackUrl = new URL(`${ORIGIN}/oauth/callback`);
		callbackUrl.searchParams.set("code", "access-code");
		callbackUrl.searchParams.set("state", accessLogin.searchParams.get("state")!);
		const callbackResponse = await dispatch(new Request(callbackUrl));
		const clientCallback = new URL(callbackResponse.headers.get("Location")!);
		expect(callbackResponse.status).toBe(302);
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
					client_id: registration.client_id,
					redirect_uri: CLIENT_REDIRECT_URI,
					code_verifier: verifier,
					resource: `${ORIGIN}/mcp`,
				}),
			}),
		);
		const token = (await tokenResponse.json()) as { access_token: string };
		expect(tokenResponse.status).toBe(200);

		const mcpResponse = await dispatch(
			mcpRequest({ Authorization: `Bearer ${token.access_token}` }),
		);
		const mcpBody = (await mcpResponse.json()) as {
			result: { tools: Array<{ name: string }> };
		};
		expect(mcpResponse.status).toBe(200);
		expect(mcpBody.result.tools.map(({ name }) => name)).toEqual([
			"search",
			"execute",
		]);
	});
});
