import {
	AuthorizationError,
	type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env";

type OwnerProps = {
	email: string;
	name: string;
	sub: string;
};

type ParkedAuthState = {
	request: AuthRequest;
	verifier: string;
};

const STATE_TTL_SECONDS = 600;

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

async function createState(request: AuthRequest, env: Env) {
	const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);

	await env.OAUTH_KV.put(
		`oauth:state:${state}`,
		JSON.stringify({ request, verifier }),
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

	const { state, challenge } = await createState(oauthRequest, env);
	const upstream = accessEndpoint(env, "authorization");
	upstream.searchParams.set("client_id", env.ACCESS_OIDC_CLIENT_ID);
	upstream.searchParams.set(
		"redirect_uri",
		new URL("/oauth/callback", request.url).href,
	);
	upstream.searchParams.set("response_type", "code");
	upstream.searchParams.set("scope", "openid email");
	upstream.searchParams.set("state", state);
	upstream.searchParams.set("code_challenge", challenge);
	upstream.searchParams.set("code_challenge_method", "S256");

	return Response.redirect(upstream, 302);
}

async function callback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const parked = await readState(url, env);
	if (!parked) {
		return new Response("Invalid or expired state", { status: 400 });
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

	if (!claims.email || !claims.sub) {
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

	return Response.redirect(redirectTo, 302);
}

export const accessHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/authorize" && request.method === "GET") {
			return authorize(request, env);
		}
		if (pathname === "/oauth/callback" && request.method === "GET") {
			return callback(request, env);
		}
		return new Response("Not found", { status: 404 });
	},
};
