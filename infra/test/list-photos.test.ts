import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { createListPhotosHandler } from "../lambda/list-photos/handler";
import { toPublicPhoto } from "../lambda/list-photos/mapping";
import { queryPhotoPages, type QueryClient } from "../lambda/list-photos/query";
import { CatalogLimitError, type PhotoUrlResolver } from "../lambda/list-photos/types";

type Page = Pick<QueryCommandOutput, "Items" | "LastEvaluatedKey">;
const event = { requestContext: { requestId: "test-request" } } as APIGatewayProxyEventV2;
const config = { tableName: "test-catalog", collectionId: "default" };
const resolveUrls: PhotoUrlResolver = photo => ({
  thumbnailUrl: `https://images.example.test/${photo.photoId}/small`,
  originalUrl: `https://images.example.test/${photo.photoId}/original`,
});
function record(photoId = "a", takenAt = "2021-03-27T14:30:00.000Z") {
  return { photoId, collectionId: "default", takenAtKey: `${takenAt}#${photoId}`,
    filename: `${photoId}.jpg`, takenAt, originalKey: `originals/${photoId}.jpg` };
}
function mockClient(pages: Page[]) {
  const commands: QueryCommand[] = [];
  const client: QueryClient = { async send(command) {
    assert.ok(command instanceof QueryCommand);
    commands.push(command);
    const page = pages[commands.length - 1];
    assert.ok(page, "Unexpected extra DynamoDB request");
    return page;
  } };
  return { client, commands };
}
async function collect(client: QueryClient, overrides = {}) {
  const pages = [];
  for await (const page of queryPhotoPages(client, { ...config, ...overrides })) pages.push(page);
  return pages;
}
function handlerFor(client: QueryClient, overrides = {}) {
  const errors: unknown[][] = [];
  const handler = createListPhotosHandler({ ...config, client, resolveUrls,
    logger: { error: (...args: unknown[]) => { errors.push(args); } }, ...overrides });
  return { handler, errors };
}

test("queries the chronological GSI newest first and follows continuation keys, including empty pages", async () => {
  const firstKey = { photoId: "z", collectionId: "default", takenAtKey: record("z").takenAtKey };
  const secondKey = { photoId: "y", collectionId: "default", takenAtKey: record("y").takenAtKey };
  const { client, commands } = mockClient([
    { Items: [record("z")], LastEvaluatedKey: firstKey },
    { Items: [], LastEvaluatedKey: secondKey },
    { Items: [record("a", "2001-01-01T00:00:00.000Z")], LastEvaluatedKey: {} },
  ]);
  assert.equal((await collect(client)).flat().length, 2);
  assert.equal(commands.length, 3);
  for (const command of commands) {
    assert.equal(command.input.TableName, "test-catalog");
    assert.equal(command.input.IndexName, "collection-date-index");
    assert.equal(command.input.ScanIndexForward, false);
    assert.equal(command.input.Limit, 250);
    assert.equal(command.input.KeyConditionExpression, "#collection = :collection");
    assert.deepEqual(command.input.ExpressionAttributeValues, { ":collection": "default" });
    assert.equal(command.input.FilterExpression, undefined);
  }
  assert.equal(commands[0]!.input.ExclusiveStartKey, undefined);
  assert.deepEqual(commands[1]!.input.ExclusiveStartKey, firstKey);
  assert.deepEqual(commands[2]!.input.ExclusiveStartKey, secondKey);
});

test("detects a repeated continuation key even with different property order", async () => {
  const { client, commands } = mockClient([
    { Items: [], LastEvaluatedKey: { photoId: "a", takenAtKey: "key" } },
    { Items: [], LastEvaluatedKey: { takenAtKey: "key", photoId: "a" } },
  ]);
  await assert.rejects(collect(client), /repeated a pagination key/);
  assert.equal(commands.length, 2);
});

test("bounds pagination by both record count and page count", async () => {
  const limits = { maxItems: 1, maxPages: 1, pageSize: 1 };
  await assert.rejects(collect(mockClient([{ Items: [record("a"), record("b")] }]).client, { limits }), CatalogLimitError);
  const { client, commands } = mockClient([{ Items: [], LastEvaluatedKey: { photoId: "a" } }]);
  await assert.rejects(collect(client, { limits }), CatalogLimitError);
  assert.equal(commands.length, 1);
});

test("rejects invalid query configuration before making a request", async () => {
  const { client, commands } = mockClient([]);
  await assert.rejects(collect(client, { tableName: "" }), /Invalid photo query/);
  await assert.rejects(collect(client, { limits: { maxItems: 1, maxPages: 0, pageSize: 1 } }), /Invalid photo query/);
  assert.equal(commands.length, 0);
});

test("empty catalog returns the frontend-compatible empty array without image delivery", async () => {
  const { handler, errors } = handlerFor(mockClient([{}]).client, { resolveUrls: undefined });
  const response = await handler(event);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "[]");
  assert.deepEqual(response.headers, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  assert.equal(response.isBase64Encoded, false);
  assert.equal(errors.length, 0);
});

test("maps only the five public Photo fields and allows missing future processing fields", () => {
  const item = { ...record(), sha256: "internal-hash", dateSource: "dateTaken", width: 4000 };
  assert.deepEqual(toPublicPhoto(item, resolveUrls), {
    id: "a", filename: "a.jpg", takenAt: item.takenAt,
    thumbnailUrl: "https://images.example.test/a/small", originalUrl: "https://images.example.test/a/original",
  });
  assert.deepEqual(Object.keys(toPublicPhoto(record(), resolveUrls)).sort(),
    ["filename", "id", "originalUrl", "takenAt", "thumbnailUrl"]);
});

test("returns the full newest-first public catalog across query pages, with stable date ties", async () => {
  const { client } = mockClient([
    { Items: [record("z"), record("a")], LastEvaluatedKey: { photoId: "a" } },
    { Items: [record("old", "2001-01-01T00:00:00.000Z")] },
  ]);
  const response = await handlerFor(client).handler(event);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body!).map((photo: { id: string }) => photo.id), ["z", "a", "old"]);
  assert.ok(!response.body!.includes("originals/"));
  assert.ok(!response.body!.includes("collectionId"));
});

test("nonempty Phase 2 catalog gives an explicit delivery-not-configured error instead of public S3 URLs", async () => {
  const response = await handlerFor(mockClient([{ Items: [record()] }]).client, { resolveUrls: undefined }).handler(event);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body!), { error: "Photo delivery is not configured yet." });
  assert.ok(!response.body!.includes("originals/"));
});

test("DynamoDB errors stay generic publicly and include request diagnostics in logs", async () => {
  const databaseError = new Error("Private DynamoDB diagnostic");
  const client: QueryClient = { send: async () => { throw databaseError; } };
  const { handler, errors } = handlerFor(client);
  const response = await handler(event);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body, '{"error":"Unable to load photos."}');
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0]![1], { requestId: "test-request", error: databaseError });
});

test("invalid catalog dates, keys and fields fail safely", async () => {
  for (const patch of [
    { takenAt: "not-a-date" }, { takenAt: "2021-03-27T14:30:00Z" },
    { takenAt: "2021-02-30T00:00:00.000Z" }, { takenAtKey: "incorrect" },
    { originalKey: "" }, { filename: 5 }, { collectionId: "other" },
  ]) {
    const response = await handlerFor(mockClient([{ Items: [{ ...record(), ...patch }] }]).client).handler(event);
    assert.equal(response.statusCode, 500, JSON.stringify(patch));
    assert.equal(response.body, '{"error":"Unable to load photos."}');
  }
});

test("duplicate IDs or out-of-order records cannot silently return a partial or corrupt timeline", async () => {
  for (const items of [[record(), record()], [record("old", "2001-01-01T00:00:00.000Z"), record()]]) {
    const response = await handlerFor(mockClient([{ Items: items }]).client).handler(event);
    assert.equal(response.statusCode, 500);
    assert.ok(!Array.isArray(JSON.parse(response.body!)));
  }
});

test("delivery URLs must be absolute HTTP(S) URLs without embedded credentials", async () => {
  for (const url of ["originals/a.jpg", "s3://bucket/a.jpg", "javascript:alert(1)", "https://user:pass@example.test/a"]) {
    const response = await handlerFor(mockClient([{ Items: [record()] }]).client, {
      resolveUrls: () => ({ thumbnailUrl: url, originalUrl: url }),
    }).handler(event);
    assert.equal(response.statusCode, 500);
  }
});

test("count and page safety limits return 413, never a partial success", async () => {
  for (const pages of [
    [{ Items: [record("z"), record("a")] }],
    [{ Items: [record()], LastEvaluatedKey: { photoId: "a" } }],
  ]) {
    const response = await handlerFor(mockClient(pages).client, { limits: { maxItems: 1, maxPages: 1, pageSize: 1 } }).handler(event);
    assert.equal(response.statusCode, 413);
    assert.ok(!Array.isArray(JSON.parse(response.body!)));
  }
});

test("response limit measures actual UTF-8 JSON bytes, including brackets and commas", async () => {
  const items = [{ ...record("z"), filename: "写真.jpg" }, record("a")];
  const expected = JSON.stringify(items.map(item => toPublicPhoto(item, resolveUrls)));
  const bytes = Buffer.byteLength(expected, "utf8");
  assert.ok(bytes > expected.length);
  const accepted = await handlerFor(mockClient([{ Items: items }]).client, { maxResponseBytes: bytes }).handler(event);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body, expected);
  const rejected = await handlerFor(mockClient([{ Items: items }]).client, { maxResponseBytes: bytes - 1 }).handler(event);
  assert.equal(rejected.statusCode, 413);
});

test("invalid handler configuration is an internal error", async () => {
  const { client, commands } = mockClient([]);
  assert.equal((await handlerFor(client, { maxResponseBytes: 1 }).handler(event)).statusCode, 500);
  assert.equal(commands.length, 0);
});
