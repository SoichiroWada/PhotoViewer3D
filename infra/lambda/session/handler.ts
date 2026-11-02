import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";

export type SessionDependencies = {
  keyPairId: string;
  privateKey: () => Promise<string>;
  /** Seconds; cookies outlive one access token so images survive token refresh. */
  lifetimeSeconds: number;
  now?: () => number;
  logger?: Pick<Console, "error">;
};

/** Issues CloudFront signed cookies for `/media/*` to an already JWT-authorized caller. */
export function createSessionHandler(dependencies: SessionDependencies) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    try {
      const expiresAt = Math.floor((dependencies.now ?? Date.now)() / 1000) + dependencies.lifetimeSeconds;
      // Host-only cookies already bind them to this distribution; the key group binds the signature.
      const policy = JSON.stringify({ Statement: [{
        Resource: "https://*/media/*",
        Condition: { DateLessThan: { "AWS:EpochTime": expiresAt } },
      }] });
      const signed = getSignedCookies({ keyPairId: dependencies.keyPairId, privateKey: await dependencies.privateKey(), policy });
      const attributes = `Path=/media/; Secure; HttpOnly; SameSite=Strict; Max-Age=${dependencies.lifetimeSeconds}`;
      const cookies = Object.entries(signed)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, value]) => `${name}=${value}; ${attributes}`);
      return { statusCode: 200, headers, cookies, body: JSON.stringify({ expiresAt: new Date(expiresAt * 1000).toISOString() }) };
    } catch (error) {
      (dependencies.logger ?? console).error("Media session failed", { requestId: event.requestContext?.requestId, error });
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Unable to start a photo session." }) };
    }
  };
}
