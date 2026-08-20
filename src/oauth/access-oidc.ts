import {
	AuthorizationError,
	type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env, OwnerProps } from "../env";

type ParkedAuthState = {
	approvalNonce?: string;
	request: AuthRequest;
	verifier: string;
};

type PendingApproval = {
	origin: string;
	request: AuthRequest;
};

const STATE_TTL_SECONDS = 600;
const APPROVAL_COOKIE = "__Host-ayo-approval";
const APPROVAL_PREFIX = "oauth:approved-client:";
const APPROVAL_NONCE_PREFIX = "oauth:approval-nonce:";

function accessIssuer(env: Env): string {
	return env.ACCESS_OIDC_ISSUER.replace(/\/+$/, "");
}

function accessEndpoint(env: Env, path: string): URL {
	return new URL(`${accessIssuer(env)}/${path}`);
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character]!,
	);
}

function approvalCookie(request: Request): string | undefined {
	return request.headers
		.get("Cookie")
		?.split(";")
		.map((cookie) => cookie.trim())
		.find((cookie) => cookie.startsWith(`${APPROVAL_COOKIE}=`))
		?.slice(APPROVAL_COOKIE.length + 1);
}

async function createState(
	request: AuthRequest,
	env: Env,
	approvalNonce?: string,
) {
	const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);

	await env.OAUTH_KV.put(
		`oauth:state:${state}`,
		JSON.stringify({ approvalNonce, request, verifier } satisfies ParkedAuthState),
		{ expirationTtl: STATE_TTL_SECONDS },
	);

	return {
		state,
		challenge: base64url(new Uint8Array(digest)),
	};
}

async function readState(
	url: URL,
	env: Env,
): Promise<ParkedAuthState | undefined> {
	const state = url.searchParams.get("state");
	if (!state) {
		return undefined;
	}

	const key = `oauth:state:${state}`;
	const stored = await env.OAUTH_KV.get(key);
	if (!stored) {
		return undefined;
	}

	await env.OAUTH_KV.delete(key);
	return JSON.parse(stored) as ParkedAuthState;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksIssuer: string | undefined;

function accessKeySet(env: Env) {
	const issuer = accessIssuer(env);
	if (!jwks || jwksIssuer !== issuer) {
		jwks = createRemoteJWKSet(accessEndpoint(env, "jwks"));
		jwksIssuer = issuer;
	}
	return jwks;
}

function authorizationErrorResponse(error: AuthorizationError): Response {
	if (!error.redirectUri) {
		return new Response(error.description, { status: 400 });
	}

	const redirect = new URL(error.redirectUri);
	redirect.searchParams.set("error", error.code);
	redirect.searchParams.set("error_description", error.description);
	if (error.state) {
		redirect.searchParams.set("state", error.state);
	}
	if (error.issuer) {
		redirect.searchParams.set("iss", error.issuer);
	}
	return Response.redirect(redirect, 302);
}

async function redirectToAccess(
	oauthRequest: AuthRequest,
	origin: string,
	env: Env,
	approvalNonce?: string,
): Promise<Response> {
	const { state, challenge } = await createState(
		oauthRequest,
		env,
		approvalNonce,
	);
	const upstream = accessEndpoint(env, "authorization");
	upstream.searchParams.set("client_id", env.ACCESS_OIDC_CLIENT_ID);
	upstream.searchParams.set(
		"redirect_uri",
		new URL("/oauth/callback", origin).href,
	);
	upstream.searchParams.set("response_type", "code");
	upstream.searchParams.set("scope", "openid email profile");
	upstream.searchParams.set("state", state);
	upstream.searchParams.set("code_challenge", challenge);
	upstream.searchParams.set("code_challenge_method", "S256");

	return Response.redirect(upstream, 302);
}

async function approvalPage(
	oauthRequest: AuthRequest,
	origin: string,
	env: Env,
): Promise<Response> {
	const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
	if (!client) {
		return new Response("Unknown OAuth client", { status: 400 });
	}

	const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
	await env.OAUTH_KV.put(
		`${APPROVAL_NONCE_PREFIX}${nonce}`,
		JSON.stringify({ origin, request: oauthRequest } satisfies PendingApproval),
		{ expirationTtl: STATE_TTL_SECONDS },
	);

	return new Response(
		`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Approve OAuth client</title></head>
<body>
<main>
<h1>Approve OAuth client?</h1>
<dl>
<dt>Client</dt><dd>${escapeHtml(client.clientName ?? oauthRequest.clientId)}</dd>
<dt>Redirect URI</dt><dd>${escapeHtml(oauthRequest.redirectUri)}</dd>
</dl>
<form method="post" action="/authorize">
<input type="hidden" name="nonce" value="${nonce}">
<button type="submit">Approve</button>
</form>
</main>
</body>
</html>`,
		{
			headers: {
				"Cache-Control": "no-store",
				"Content-Security-Policy":
					"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
				"Content-Type": "text/html; charset=utf-8",
				"Set-Cookie": `${APPROVAL_COOKIE}=${nonce}; Path=/; Max-Age=${STATE_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
				"X-Frame-Options": "DENY",
			},
		},
	);
}

async function authorize(request: Request, env: Env): Promise<Response> {
	let oauthRequest: AuthRequest;
	try {
		oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return authorizationErrorResponse(error);
		}
		throw error;
	}

	const origin = new URL(request.url).origin;
	const approved = await env.OAUTH_KV.get(
		`${APPROVAL_PREFIX}${oauthRequest.clientId}`,
	);
	if (approved) {
		return redirectToAccess(oauthRequest, origin, env);
	}
	return approvalPage(oauthRequest, origin, env);
}

async function approve(request: Request, env: Env): Promise<Response> {
	const nonce = await request
		.formData()
		.then((form) => form.get("nonce"))
		.catch((error: unknown) => {
			console.error("Approval form parse failed", {
				reason: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	if (typeof nonce !== "string" || approvalCookie(request) !== nonce) {
		console.error("Approval rejected", {
			reason:
				typeof nonce !== "string" ? "missing nonce field" : "cookie mismatch",
		});
		return new Response(
			"Approval expired or was superseded - restart the sign-in from your client",
			{ status: 400 },
		);
	}

	const key = `${APPROVAL_NONCE_PREFIX}${nonce}`;
	const stored = await env.OAUTH_KV.get(key);
	if (!stored) {
		return new Response("Invalid or expired approval", { status: 400 });
	}
	await env.OAUTH_KV.delete(key);

	const pending = JSON.parse(stored) as PendingApproval;
	if (pending.origin !== new URL(request.url).origin) {
		return new Response("Invalid approval origin", { status: 400 });
	}

	return redirectToAccess(pending.request, pending.origin, env, nonce);
}

async function callback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const parked = await readState(url, env);
	if (!parked) {
		return new Response("Invalid or expired state", { status: 400 });
	}
	if (
		parked.approvalNonce &&
		approvalCookie(request) !== parked.approvalNonce
	) {
		console.error("Callback approval cookie mismatch", {
			clientId: parked.request.clientId,
		});
		return new Response(
			"Approval browser does not match - restart the sign-in from your client",
			{ status: 400 },
		);
	}

	const code = url.searchParams.get("code");
	if (!code) {
		return new Response("Missing authorization code", { status: 400 });
	}

	const exchange = await fetch(accessEndpoint(env, "token"), {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.ACCESS_OIDC_CLIENT_ID,
			client_secret: env.ACCESS_OIDC_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: new URL("/oauth/callback", request.url).href,
			code_verifier: parked.verifier,
		}),
	});

	const exchangeBody = await exchange.text();
	if (!exchange.ok) {
		console.error("Access token exchange failed", {
			status: exchange.status,
			body: exchangeBody,
		});
		return new Response("Access rejected the authorization code", {
			status: 502,
		});
	}

	let tokenResponse: { id_token?: string };
	try {
		tokenResponse = JSON.parse(exchangeBody) as { id_token?: string };
	} catch {
		console.error("Access token endpoint returned non-JSON", {
			status: exchange.status,
			body: exchangeBody,
		});
		return new Response("Access returned an unexpected response", {
			status: 502,
		});
	}
	if (!tokenResponse.id_token) {
		console.error("Access token response had no id_token", {
			body: exchangeBody,
		});
		return new Response("Access returned no ID token", { status: 502 });
	}

	let claims: { email?: string; name?: string; sub?: string };
	try {
		const verified = await jwtVerify(tokenResponse.id_token, accessKeySet(env), {
			audience: env.ACCESS_OIDC_CLIENT_ID,
			issuer: accessIssuer(env),
		});
		claims = verified.payload as typeof claims;
	} catch (error) {
		console.error("Access ID token verification failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return new Response("Could not verify the Access ID token", { status: 502 });
	}

	if (typeof claims.email !== "string" || typeof claims.sub !== "string") {
		console.error("Access ID token missing identity claims", {
			hasEmail: typeof claims.email === "string",
			hasSub: typeof claims.sub === "string",
		});
		return new Response("Access returned an incomplete identity", { status: 502 });
	}

	const name = typeof claims.name === "string" ? claims.name : claims.email;
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: parked.request,
		userId: claims.sub,
		scope: parked.request.scope.filter((scope) => scope === "mcp"),
		metadata: { label: name },
		props: {
			email: claims.email,
			name,
			sub: claims.sub,
		} satisfies OwnerProps,
	});

	if (parked.approvalNonce) {
		await env.OAUTH_KV.put(
			`${APPROVAL_PREFIX}${parked.request.clientId}`,
			"approved",
		);
	}

	return Response.redirect(redirectTo, 302);
}

export const accessHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/authorize" && request.method === "GET") {
			return authorize(request, env);
		}
		if (pathname === "/authorize" && request.method === "POST") {
			return approve(request, env);
		}
		if (pathname === "/oauth/callback" && request.method === "GET") {
			return callback(request, env);
		}
		return new Response("Not found", { status: 404 });
	},
};
