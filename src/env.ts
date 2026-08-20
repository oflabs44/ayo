import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Env = {
	ACCESS_OIDC_CLIENT_ID: string;
	ACCESS_OIDC_CLIENT_SECRET: string;
	ACCESS_OIDC_ISSUER: string;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
};
