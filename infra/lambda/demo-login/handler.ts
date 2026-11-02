import { randomBytes } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export type DemoTokens = { accessToken: string; idToken: string; expiresIn: number };
export type DemoDependencies = {
  /** Sets a permanent password; throws an error named `UserNotFoundException` when the user is missing. */
  setPassword(password: string): Promise<void>;
  createUser(): Promise<void>;
  /** Idempotent; runs on every fresh sign-in so a lost membership can never grant upload or delete. */
  addToDemoGroup(): Promise<void>;
  signIn(password: string): Promise<DemoTokens>;
  now?: () => number;
  logger?: Pick<Console, "error">;
};

/** Cached tokens are reused while they have this long left, so most visits make no Cognito calls. */
const MIN_REMAINING_MS = 10 * 60 * 1000;

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

/**
 * Signs visitors in as the shared demo user without a password. The password is
 * random and replaced on every fresh sign-in, so nothing secret is stored and a
 * demo visitor who changes or deletes the account cannot lock others out.
 */
export function createDemoLoginHandler(deps: DemoDependencies) {
  const now = deps.now ?? Date.now;
  let cached: { tokens: DemoTokens; expiresAt: number } | undefined;

  async function freshTokens(): Promise<DemoTokens> {
    const password = `Demo-${randomBytes(24).toString("base64url")}`;
    try {
      await deps.setPassword(password);
    } catch (error) {
      if ((error as { name?: string }).name !== "UserNotFoundException") throw error;
      await deps.createUser();
      await deps.setPassword(password);
    }
    await deps.addToDemoGroup();
    return deps.signIn(password);
  }

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      if (!cached || cached.expiresAt - now() < MIN_REMAINING_MS) {
        const tokens = await freshTokens();
        cached = { tokens, expiresAt: now() + tokens.expiresIn * 1000 };
      }
      const { tokens, expiresAt } = cached;
      return json(200, { access_token: tokens.accessToken, id_token: tokens.idToken,
        expires_in: Math.floor((expiresAt - now()) / 1000) });
    } catch (error) {
      cached = undefined;
      (deps.logger ?? console).error("Demo sign-in failed", { requestId: event.requestContext?.requestId, error });
      return json(500, { error: "Unable to start the demo. Please try again." });
    }
  };
}
