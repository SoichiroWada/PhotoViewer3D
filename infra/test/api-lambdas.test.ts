import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { createSessionHandler } from "../lambda/session/handler";
import { createUploadHandler, safeFilename, type PostPresigner } from "../lambda/create-upload/handler";

const event = { requestContext: { requestId: "r" } } as APIGatewayProxyEventV2;
const fromCloudFrontBase64 = (value: string) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");

test("session issues three HttpOnly, Secure, media-scoped CloudFront cookies with a verifiable policy", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
  const handler = createSessionHandler({ keyPairId: "K123", privateKey: async () => privateKey, lifetimeSeconds: 3600, now: () => 1_700_000_000_000 });
  const response = await handler(event);
  assert.equal(response.statusCode, 200);
  const cookies = Object.fromEntries(response.cookies!.map(cookie => {
    assert.match(cookie, /; Path=\/media\/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600$/);
    const [pair] = cookie.split(";"); const index = pair!.indexOf("=");
    return [pair!.slice(0, index), pair!.slice(index + 1)];
  }));
  assert.deepEqual(Object.keys(cookies).sort(), ["CloudFront-Key-Pair-Id", "CloudFront-Policy", "CloudFront-Signature"]);
  assert.equal(cookies["CloudFront-Key-Pair-Id"], "K123");
  const policy = fromCloudFrontBase64(cookies["CloudFront-Policy"]!);
  assert.deepEqual(JSON.parse(policy.toString()), { Statement: [{ Resource: "https://*/media/*",
    Condition: { DateLessThan: { "AWS:EpochTime": 1_700_003_600 } } }] });
  const verify = createVerify("RSA-SHA1"); verify.update(policy);
  assert.ok(verify.verify(publicKey, fromCloudFrontBase64(cookies["CloudFront-Signature"]!)));
  assert.equal(response.headers!["Cache-Control"], "no-store");
});

test("session hides key-loading failures behind a generic error", async () => {
  const errors: unknown[] = [];
  const handler = createSessionHandler({ keyPairId: "K", privateKey: async () => { throw new Error("AccessDenied: arn:..."); },
    lifetimeSeconds: 60, logger: { error: (...args: unknown[]) => { errors.push(args); } } });
  const response = await handler(event);
  assert.equal(response.statusCode, 500);
  assert.ok(!response.body!.includes("arn"));
  assert.equal(errors.length, 1);
});

function uploadEvent(body: unknown): APIGatewayProxyEventV2WithJWTAuthorizer {
  return { body: typeof body === "string" ? body : JSON.stringify(body), isBase64Encoded: false,
    requestContext: { requestId: "r", authorizer: { jwt: { claims: { sub: "user-1" }, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

test("upload presigns a size- and type-bound POST under incoming/ with uploader and mtime metadata", async () => {
  const calls: Parameters<PostPresigner>[0][] = [];
  const handler = createUploadHandler(async input => { calls.push(input); return { url: "https://bucket.example", fields: { key: input.key } }; });
  const response = await handler(uploadEvent({ filename: "C:\\fakepath\\Holiday.JPG", size: 1234, lastModified: Date.UTC(2020, 0, 2) }));
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.key, /^incoming\/[0-9a-f-]{36}\/Holiday\.JPG$/);
  assert.equal(calls[0]!.contentType, "image/jpeg");
  assert.equal(calls[0]!.maxBytes, 1234);
  assert.deepEqual(calls[0]!.metadata, { uploader: "user-1", mtime: "2020-01-02T00:00:00.000Z" });
  assert.ok(calls[0]!.expiresSeconds <= 900);
});

test("upload rejects bad JSON, unsupported types and invalid sizes before presigning", async () => {
  const handler = createUploadHandler(async () => { throw new Error("should not presign"); });
  for (const body of ["{", { filename: "a.gif", size: 1 }, { filename: "a.jpg", size: 0 }, { filename: "a.jpg", size: 65 * 1024 * 1024 },
    { filename: "a.jpg", size: 1.5 }, { filename: "..", size: 1 }, { size: 1 }]) {
    assert.equal((await handler(uploadEvent(body))).statusCode, 400, JSON.stringify(body));
  }
  assert.equal(safeFilename("../../etc/passwd.jpg"), "passwd.jpg");
  assert.equal(safeFilename("a\u0000b.jpg"), "ab.jpg");
});
