import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createSessionHandler } from "./handler";

const ssm = new SSMClient({ maxAttempts: 2 });
let cachedKey: Promise<string> | undefined;

export const handler = createSessionHandler({
  keyPairId: process.env.CLOUDFRONT_KEY_PAIR_ID ?? "",
  lifetimeSeconds: Number(process.env.MEDIA_COOKIE_SECONDS ?? 43200),
  privateKey: () => cachedKey ??= ssm.send(new GetParameterCommand({
    Name: process.env.SIGNING_KEY_PARAMETER, WithDecryption: true,
  })).then(result => {
    const value = result.Parameter?.Value;
    if (!value) throw new Error("Signing key parameter is empty.");
    return value;
  }).catch(error => { cachedKey = undefined; throw error; }),
});
