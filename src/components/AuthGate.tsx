"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createCognitoAuth, loadAuthConfig, type CognitoAuth } from "@/lib/auth/cognitoAuth";
import { startMediaSession } from "@/lib/api/awsApi";

/** `local`: no auth-config.json, so the local backend is used without sign-in. */
export type AuthContextValue =
  | { mode: "local" }
  | { mode: "cognito"; email: string | null; getAccessToken: () => Promise<string | null>; signOut: () => void };

const AuthContext = createContext<AuthContextValue>({ mode: "local" });
export const useAuth = () => useContext(AuthContext);

// Cookies last 12 hours; renew well before that while the page stays open.
const MEDIA_SESSION_RENEW_MS = 60 * 60 * 1000;
type GateState = "checking" | "local" | "signedOut" | "ready" | "error";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const auth = useRef<CognitoAuth | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const config = await loadAuthConfig();
      if (!config) { if (!cancelled) setState("local"); return; }
      const client = auth.current ??= createCognitoAuth(config, {
        fetch: window.fetch.bind(window), storage: localStorage, session: sessionStorage,
        location: window.location, history: window.history,
      });
      await client.handleRedirect();
      const token = await client.getAccessToken();
      if (!token) { if (!cancelled) setState("signedOut"); return; }
      await startMediaSession(() => client.getAccessToken());
      if (!cancelled) setState("ready");
    })().catch(reason => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : "Unable to sign in.");
      setState("error");
    });
    return () => { cancelled = true; };
  }, [attempt]);

  useEffect(() => {
    if (state !== "ready" || !auth.current) return;
    const client = auth.current;
    const timer = window.setInterval(() => {
      startMediaSession(() => client.getAccessToken()).catch(() => setState("signedOut"));
    }, MEDIA_SESSION_RENEW_MS);
    return () => window.clearInterval(timer);
  }, [state]);

  const signOut = useCallback(() => { void auth.current?.signOut(); }, []);
  const value = useMemo<AuthContextValue>(() => state === "ready" && auth.current
    ? { mode: "cognito", email: auth.current.email(), getAccessToken: () => auth.current!.getAccessToken(), signOut }
    : { mode: "local" }, [state, signOut]);

  if (state === "local" || state === "ready") return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
  return (
    <main className="viewer viewer--gate">
      <div className="viewer-message" role={state === "error" ? "alert" : "status"}>
        <span className="brand__mark" aria-hidden="true"><span /><span /></span>
        {state === "checking" && <><span className="loader" /><h2>Opening your collection</h2></>}
        {state === "signedOut" && <>
          <p className="eyebrow">A walk through time</p>
          <h2>3D Photo Viewer</h2>
          <p>Sign in with your invited account to see the collection.</p>
          <button className="button button--primary" onClick={() => void auth.current?.signIn()}>Sign in</button>
        </>}
        {state === "error" && <>
          <h2>Couldn’t sign you in</h2><p>{error}</p>
          <div className="gate-actions">
            <button className="button button--primary" onClick={() => { setState("checking"); setAttempt(value => value + 1); }}>Try again</button>
            {auth.current && <button className="button" onClick={signOut}>Sign out</button>}
          </div>
        </>}
      </div>
    </main>
  );
}
