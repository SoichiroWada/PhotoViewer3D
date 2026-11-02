import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { createDeleteHandler, MAX_DELETE_IDS, parseDeleteIds, type DeleteDependencies } from "../lambda/delete-photos/handler";

const id = (n: number) => n.toString(16).padStart(32, "0");
const event = (body: unknown) => ({ body: typeof body === "string" ? body : JSON.stringify(body), isBase64Encoded: false,
  requestContext: { requestId: "r", authorizer: { jwt: { claims: { sub: "user-1" }, scopes: [] } } } }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
const record = (photoId: string) => ({ photoId, originalKey: `media/originals/${photoId}.jpg`,
  smallKey: `media/variants/${photoId}/small.webp`, mediumKey: `media/variants/${photoId}/medium.webp`, largeKey: `media/variants/${photoId}/large.webp` });
const quiet = { info() {}, error() {} };

function fakeStore(items: Record<string, Record<string, unknown>>, failMedia = new Set<string>()) {
  const calls: string[] = [];
  const deps: DeleteDependencies = {
    async getCatalog(photoId) { return items[photoId]; },
    async deleteCatalog(photoId) { calls.push(`catalog:${photoId}`); delete items[photoId]; },
    async deleteMedia(keys) {
      if (keys.some(key => failMedia.has(key))) throw new Error("AccessDenied");
      calls.push(...keys.map(key => `media:${key}`));
    },
    logger: quiet,
  };
  return { deps, calls };
}

test("deletes the catalog record before its original and variants, and repeats are harmless", async () => {
  const items = { [id(1)]: record(id(1)), [id(2)]: record(id(2)) };
  const { deps, calls } = fakeStore(items);
  const response = await createDeleteHandler(deps)(event({ ids: [id(1), id(3)] }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body!), { deleted: [id(1), id(3)], failed: [] });
  assert.deepEqual(calls, [`catalog:${id(1)}`, ...Object.values(record(id(1))).slice(1).map(key => `media:${key}`)]);
  assert.ok(items[id(2)], "unselected photos stay");
});

test("one failing photo is reported without stopping the rest or leaking details", async () => {
  const items = { [id(1)]: record(id(1)), [id(2)]: record(id(2)) };
  const { deps } = fakeStore(items, new Set([record(id(1)).originalKey]));
  const response = await createDeleteHandler(deps)(event({ ids: [id(1), id(2)] }));
  const body = JSON.parse(response.body!);
  assert.deepEqual(body.deleted, [id(2)]);
  assert.deepEqual(body.failed, [{ id: id(1), error: "Unable to delete this photo." }]);
});

test("media keys outside media/ are never deleted", async () => {
  const items = { [id(1)]: { ...record(id(1)), originalKey: "site/index.html", smallKey: "media/../x" } };
  const { deps, calls } = fakeStore(items);
  await createDeleteHandler(deps)(event({ ids: [id(1)] }));
  assert.ok(calls.every(call => call.startsWith("catalog:") || call.startsWith("media:media/variants/")));
});

test("rejects bad JSON, empty, oversized and malformed ID lists", async () => {
  const handler = createDeleteHandler(fakeStore({}).deps);
  assert.equal((await handler(event("{"))).statusCode, 400);
  for (const body of [{}, { ids: [] }, { ids: "x" }, { ids: ["../etc"] }, { ids: ["A".repeat(32)] },
    { ids: Array.from({ length: MAX_DELETE_IDS + 1 }, (_, n) => id(n)) }]) {
    assert.equal((await handler(event(body))).statusCode, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.deepEqual(parseDeleteIds({ ids: [id(1), id(1)] }), [id(1)]);
});
