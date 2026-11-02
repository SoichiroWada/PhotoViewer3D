import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteConfirmMessage, selectionRange } from "../src/lib/photoSelection";
import { deletePhotos } from "../src/lib/api/awsApi";

test("the confirmation names up to three photos and counts the rest", () => {
  assert.equal(deleteConfirmMessage(["A.jpg"]), "A.jpg を削除しますか？");
  assert.equal(deleteConfirmMessage(["A.jpg", "B.jpg", "C.jpg"]), "A.jpg、B.jpg、C.jpg を削除しますか？");
  assert.equal(deleteConfirmMessage(["A.jpg", "B.jpg", "C.jpg", "D.jpg", "E.jpg"]), "A.jpg、B.jpg、C.jpg ほか2枚を削除しますか？");
});

test("shift selection covers the range in display order, in either direction", () => {
  const ids = ["a", "b", "c", "d", "e"];
  assert.deepEqual(selectionRange(ids, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(selectionRange(ids, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(selectionRange(ids, "gone", "c"), ["c"]);
});

test("deletes go out in batches of 100 and a failed batch is reported per photo", async () => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://example.test/api";
  const ids = Array.from({ length: 150 }, (_, n) => `id-${n}`);
  const bodies: { ids: string[] }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://example.test/api/photos/delete");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer t");
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if (bodies.length === 2) return new Response(JSON.stringify({ error: "Boom" }), { status: 500 });
    return new Response(JSON.stringify({ deleted: body.ids, failed: [] }));
  }) as unknown as typeof fetch;
  const result = await deletePhotos(ids, async () => "t", fetcher);
  assert.deepEqual(bodies.map(body => body.ids.length), [100, 50]);
  assert.equal(result.deleted.length, 100);
  assert.equal(result.failed.length, 50);
  assert.equal(result.failed[0]!.error, "Boom");
});
