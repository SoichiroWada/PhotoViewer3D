import { generateKeyPairSync } from "node:crypto";
import { DeleteParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { CloudFormationCustomResourceEvent } from "aws-lambda";

const ssm = new SSMClient({});

/**
 * Creates the CloudFront signing key pair. The private key exists only in an
 * SSM SecureString; only the public key is returned to CloudFormation.
 * Bumping `KeyVersion` rotates to a new parameter name; CloudFormation then
 * deletes the old parameter, never the new one.
 */
export async function handler(event: CloudFormationCustomResourceEvent) {
  const prefix = String(event.ResourceProperties.ParameterPrefix);
  const name = `${prefix}/v${String(event.ResourceProperties.KeyVersion)}`;
  if (event.RequestType === "Delete") {
    try { await ssm.send(new DeleteParameterCommand({ Name: event.PhysicalResourceId })); }
    catch (error) { if (!(error instanceof ParameterNotFound)) throw error; }
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  await ssm.send(new PutParameterCommand({
    Name: name, Type: "SecureString", Value: privateKey, Overwrite: true,
    Description: "PhotoViewer3D CloudFront signed-cookie private key (managed by CloudFormation)",
  }));
  return { PhysicalResourceId: name, Data: { PublicKeyPem: publicKey, ParameterName: name } };
}
