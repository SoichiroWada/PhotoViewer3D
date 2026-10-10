/**
 * Cognito Hosted UI sign-in using the OAuth authorization-code flow with PKCE.
 * No client secret exists; the refresh token is kept in localStorage so a
 * signed-in browser stays signed in for the refresh-token lifetime (30 days).
 */
export type AuthConfig = { region: string; userPoolId: string; clientId: string; cognitoDomain: string };
type Tokens = { accessToken: string; idToken: string; expiresAt: number };
type Environment = {
  fetch: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  session: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  location: Pick<Location, "origin" | "href" | "assign">;
  history?: Pick<History, "replaceState">;
  now?: () => number;
};

const REFRESH_KEY = "photoViewer3d.refreshToken";
const PKCE_KEY = "photoViewer3d.pkce";
const SCOPES = "openid email profile";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Reads `/auth-config.json`; absence means the local, unauthenticated backend. */
export async function loadAuthConfig(fetcher: typeof fetch = fetch): Promise<AuthConfig | null> {
  const response = await fetcher("/auth-config.json", { cache: "no-store" });
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Unable to load sign-in settings (HTTP ${response.status}).`);
  const data: unknown = await response.json().catch(() => null);
  const config = data as Record<string, unknown> | null;
  for (const key of ["region", "userPoolId", "clientId", "cognitoDomain"]) {
    if (typeof config?.[key] !== "string" || !config[key]) throw new Error("Sign-in settings are invalid.");
  }
  if (new URL(config!.cognitoDomain as string).protocol !== "https:") throw new Error("Sign-in settings are invalid.");
  return config as AuthConfig;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
  } catch { return {}; }
}

export function createCognitoAuth(config: AuthConfig, env: Environment) {
  const redirectUri = `${env.location.origin}/`;
  const now = env.now ?? Date.now;
  let tokens: Tokens | null = null;
  let refreshing: Promise<string | null> | null = null;

  async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await env.fetch(`${config.cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, ...body }).toString(),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = new Error(typeof data.error === "string" ? data.error : `Token request failed (HTTP ${response.status}).`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return data;
  }

  function store(data: Record<string, unknown>) {
    if (typeof data.access_token !== "string" || typeof data.id_token !== "string") throw new Error("Sign-in returned no tokens.");
    tokens = { accessToken: data.access_token, idToken: data.id_token, expiresAt: now() + Number(data.expires_in ?? 3600) * 1000 };
    if (typeof data.refresh_token === "string") env.storage.setItem(REFRESH_KEY, data.refresh_token);
  }

  return {
    async signIn() {
      const verifier = randomString(48);
      const state = randomString(16);
      env.session.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
      const url = new URL(`${config.cognitoDomain}/oauth2/authorize`);
      url.search = new URLSearchParams({
        response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: SCOPES,
        state, code_challenge_method: "S256", code_challenge: await pkceChallenge(verifier),
      }).toString();
      env.location.assign(url.href);
    },

    /** Completes a Hosted UI redirect; returns false when the URL is not a callback. */
    async handleRedirect(): Promise<boolean> {
      const url = new URL(env.location.href);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      if (!code && !error) return false;
      const saved = env.session.getItem(PKCE_KEY);
      env.session.removeItem(PKCE_KEY);
      env.history?.replaceState(null, "", redirectUri);
      if (error) throw new Error(`Sign-in failed: ${error}`);
      const pkce = saved ? JSON.parse(saved) as { verifier?: string; state?: string } : {};
      if (!pkce.verifier || pkce.state !== url.searchParams.get("state")) throw new Error("Sign-in could not be verified. Please try again.");
      store(await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: redirectUri, code_verifier: pkce.verifier }));
      return true;
    },

    /** A valid access token, refreshing when it is within a minute of expiry. */
    async getAccessToken(): Promise<string | null> {
      if (tokens && tokens.expiresAt - 60_000 > now()) return tokens.accessToken;
      const refreshToken = env.storage.getItem(REFRESH_KEY);
      if (!refreshToken) return null;
      refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken })
        .then(data => { store(data); return tokens!.accessToken; })
        .catch(error => {
          // Only a rejected token ends the session; network failures may recover.
          if ((error as { status?: number }).status === 400) { env.storage.removeItem(REFRESH_KEY); tokens = null; return null; }
          throw error;
        })
        .finally(() => { refreshing = null; });
      return refreshing;
    },

    email(): string | null {
      const claims = tokens ? decodeJwtPayload(tokens.idToken) : {};
      return typeof claims.email === "string" ? claims.email : null;
    },

    async signOut() {
      const refreshToken = env.storage.getItem(REFRESH_KEY);
      env.storage.removeItem(REFRESH_KEY);
      tokens = null;
      if (refreshToken) {
        await env.fetch(`${config.cognitoDomain}/oauth2/revoke`, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken, client_id: config.clientId }).toString(),
        }).catch(() => undefined);
      }
      const url = new URL(`${config.cognitoDomain}/logout`);
      url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri }).toString();
      env.location.assign(url.href);
    },
  };
}

export type CognitoAuth = ReturnType<typeof createCognitoAuth>;
