import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createCognitoAuth, decodeJwtPayload, loadAuthConfig, pkceChallenge } from "../src/lib/auth/cognitoAuth";

const config = { region: "ap-northeast-1", userPoolId: "pool", clientId: "client-1", cognitoDomain: "https://auth.example.test" };
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, values };
}
function environment(href = "https://viewer.example.test/", responses: Response[] = []) {
  const requests: { url: string; body: URLSearchParams }[] = [];
  const assigned: string[] = [];
  const replaced: string[] = [];
  let time = 1_000_000;
  const env = {
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
      const response = responses.shift();
      assert.ok(response, `unexpected request to ${url}`);
      return response;
    }) as typeof fetch,
    storage: memoryStorage(), session: memoryStorage(),
    location: { origin: new URL(href).origin, href, assign: (url: string) => { assigned.push(url); } },
    history: { replaceState: (_: unknown, __: string, url?: string | URL | null) => { replaced.push(String(url)); } },
    now: () => time,
  };
  return { env, requests, assigned, replaced, advance: (ms: number) => { time += ms; } };
}
const tokenResponse = (extra: object = {}) => Response.json({
  access_token: "access-1", id_token: jwt({ email: "user@example.test" }), expires_in: 3600, ...extra,
});

test("PKCE challenge is the RFC 7636 S256 transform", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(await pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(await pkceChallenge("abc"), createHash("sha256").update("abc").digest("base64url"));
});

test("signIn redirects to the Hosted UI with S256 PKCE and remembers verifier and state", async () => {
  const { env, assigned } = environment();
  await createCognitoAuth(config, env).signIn();
  const url = new URL(assigned[0]!);
  assert.equal(url.origin + url.pathname, "https://auth.example.test/oauth2/authorize");
  const saved = JSON.parse(env.session.getItem("photoViewer3d.pkce")!);
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("redirect_uri"), "https://viewer.example.test/");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), await pkceChallenge(saved.verifier));
  assert.equal(url.searchParams.get("state"), saved.state);
});

test("callback exchanges the code once, strips it from the URL, and keeps the refresh token", async () => {
  const { env, requests, replaced } = environment("https://viewer.example.test/?code=abc&state=s1", [tokenResponse({ refresh_token: "refresh-1" })]);
  env.session.setItem("photoViewer3d.pkce", JSON.stringify({ verifier: "v1", state: "s1" }));
  const auth = createCognitoAuth(config, env);
  assert.equal(await auth.handleRedirect(), true);
  assert.equal(requests[0]!.url, "https://auth.example.test/oauth2/token");
  assert.deepEqual(Object.fromEntries(requests[0]!.body), {
    client_id: "client-1", grant_type: "authorization_code", code: "abc", redirect_uri: "https://viewer.example.test/", code_verifier: "v1",
  });
  assert.deepEqual(replaced, ["https://viewer.example.test/"]);
  assert.equal(env.session.getItem("photoViewer3d.pkce"), null);
  assert.equal(env.storage.getItem("photoViewer3d.refreshToken"), "refresh-1");
  assert.equal(await auth.getAccessToken(), "access-1");
  assert.equal(auth.email(), "user@example.test");
});

test("callback rejects a mismatched state and Hosted UI errors; non-callback URLs are ignored", async () => {
  const forged = environment("https://viewer.example.test/?code=abc&state=attacker");
  forged.env.session.setItem("photoViewer3d.pkce", JSON.stringify({ verifier: "v1", state: "s1" }));
  await assert.rejects(createCognitoAuth(config, forged.env).handleRedirect(), /could not be verified/);
  assert.equal(forged.requests.length, 0);
  await assert.rejects(createCognitoAuth(config, environment("https://viewer.example.test/?error=access_denied").env).handleRedirect(), /access_denied/);
  assert.equal(await createCognitoAuth(config, environment().env).handleRedirect(), false);
});

test("access tokens refresh near expiry; a rejected refresh token signs the user out", async () => {
  const { env, requests, advance } = environment("https://viewer.example.test/", [
    tokenResponse({ access_token: "access-2" }),
    Response.json({ error: "invalid_grant" }, { status: 400 }),
  ]);
  env.storage.setItem("photoViewer3d.refreshToken", "refresh-1");
  const auth = createCognitoAuth(config, env);
  const [first, concurrent] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(first, "access-2"); assert.equal(concurrent, "access-2");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.body.get("grant_type"), "refresh_token");
  advance(3600_000 - 30_000);
  assert.equal(await auth.getAccessToken(), null);
  assert.equal(env.storage.getItem("photoViewer3d.refreshToken"), null);
});

test("network failures during refresh keep the refresh token for a later retry", async () => {
  const { env } = environment();
  env.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
  env.storage.setItem("photoViewer3d.refreshToken", "refresh-1");
  await assert.rejects(createCognitoAuth(config, env).getAccessToken(), /offline/);
  assert.equal(env.storage.getItem("photoViewer3d.refreshToken"), "refresh-1");
});

test("signOut revokes the refresh token and leaves through the Hosted UI logout", async () => {
  const { env, requests, assigned } = environment("https://viewer.example.test/", [new Response(null, { status: 200 })]);
  env.storage.setItem("photoViewer3d.refreshToken", "refresh-1");
  await createCognitoAuth(config, env).signOut();
  assert.equal(requests[0]!.url, "https://auth.example.test/oauth2/revoke");
  assert.equal(requests[0]!.body.get("token"), "refresh-1");
  assert.equal(env.storage.getItem("photoViewer3d.refreshToken"), null);
  const logout = new URL(assigned[0]!);
  assert.equal(logout.pathname, "/logout");
  assert.equal(logout.searchParams.get("logout_uri"), "https://viewer.example.test/");
});

test("auth config: missing file means local mode; malformed settings are rejected", async () => {
  assert.equal(await loadAuthConfig(async () => new Response("", { status: 404 })), null);
  assert.equal(await loadAuthConfig(async () => new Response("", { status: 403 })), null);
  assert.deepEqual(await loadAuthConfig(async () => Response.json(config)), config);
  await assert.rejects(loadAuthConfig(async () => Response.json({ ...config, clientId: "" })), /invalid/);
  await assert.rejects(loadAuthConfig(async () => Response.json({ ...config, cognitoDomain: "http://auth.example.test" })), /invalid/);
  await assert.rejects(loadAuthConfig(async () => new Response("", { status: 500 })), /HTTP 500/);
  assert.deepEqual(decodeJwtPayload("not-a-jwt"), {});
});
