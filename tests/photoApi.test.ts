import assert from "node:assert/strict";
import { test } from "node:test";
import { createPhotoApi, getPhotoUrl, getPhotoVariantUrl } from "../src/lib/api/photoApi";

const photo = {
  id: "abc", filename: "Memory.jpg", takenAt: "2020-01-01T00:00:00.000Z",
  thumbnailUrl: "/api/photos/abc?v=revision&size=small", originalUrl: "/api/photos/abc?v=revision&size=original",
};
const api = (data: unknown, config: Partial<Parameters<typeof createPhotoApi>[0]> = {}) => createPhotoApi({
  apiBaseUrl: "https://api.example.test/v1/", fetch: async () => Response.json(data), ...config,
});

test("API bases keep deployment prefixes and add a single photos endpoint", () => {
  for (const base of ["https://api.example.test/v1", "https://api.example.test/v1/"]) {
    assert.equal(api([], { apiBaseUrl: base }).metadataUrl(), "https://api.example.test/v1/photos");
  }
  assert.equal(api([], { apiBaseUrl: "http://127.0.0.1:4000" }).metadataUrl(), "http://127.0.0.1:4000/photos");
});

test("getPhotos fetches external metadata, forwards abort, and resolves images against their separate base", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = api([photo], { photoBaseUrl: "https://images.example.test/assets/", fetch: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.example.test/v1/photos");
    assert.equal(options?.signal, controller.signal);
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.cache, "no-store");
    return Response.json([photo]);
  } });
  const [normalized] = await client.getPhotos({ signal: controller.signal });
  assert.equal(calls, 1);
  assert.equal(normalized.thumbnailUrl, "https://images.example.test/api/photos/abc?v=revision&size=small");
  assert.equal(normalized.originalUrl, "https://images.example.test/api/photos/abc?v=revision&size=original");
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(photo).sort());
  assert.equal(getPhotoUrl("photos/abc.webp", "https://images.example.test/assets"), "https://images.example.test/assets/photos/abc.webp");
  assert.equal((await api([photo]).getPhotos())[0].thumbnailUrl, "https://api.example.test/api/photos/abc?v=revision&size=small");
});

test("absolute external and signed URLs are preserved; variants retain query parameters and fragments", async () => {
  const thumbnailUrl = "https://images.example.test/library/abc?signature=a%2Fb&size=small#preview";
  const originalUrl = "https://bucket.example.test/Original.JPG?signature=a%2Fb&expires=42";
  const [external] = await api([{ ...photo, thumbnailUrl, originalUrl }]).getPhotos();
  assert.equal(external.thumbnailUrl, thumbnailUrl);
  assert.equal(external.originalUrl, originalUrl);
  assert.equal(getPhotoVariantUrl(external, "medium"), "https://images.example.test/library/abc?signature=a%2Fb&size=medium#preview");
  assert.equal(getPhotoVariantUrl(external, "original"), originalUrl);
  const queryUrl = getPhotoVariantUrl({ ...external, thumbnailUrl: "https://images.example.test/photos/abc?token=a?b&size=small" }, "large");
  assert.equal(new URL(queryUrl).searchParams.get("token"), "a?b");
  assert.equal(new URL(queryUrl).searchParams.get("size"), "large");
  assert.equal(getPhotoVariantUrl({ ...external, thumbnailUrl: "https://images.example.test/photos/abc?v=1" }, "large"), "https://images.example.test/photos/abc?v=1&size=large");
  assert.equal(getPhotoVariantUrl({ ...external, thumbnailUrl: originalUrl }, "large"), originalUrl);
  assert.equal(getPhotoVariantUrl({ ...external, thumbnailUrl: "/favicon.svg" }, "small"), "/favicon.svg");
});

test("missing or invalid API configuration fails without a same-origin request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json([]); };
  for (const apiBaseUrl of [undefined, "", "   "]) {
    await assert.rejects(createPhotoApi({ apiBaseUrl, fetch: fetcher }).getPhotos(), /NEXT_PUBLIC_API_BASE_URL/);
  }
  for (const apiBaseUrl of ["/api", "file:///tmp/photos", "https://user:secret@example.test", "https://example.test?token=1"]) {
    await assert.rejects(createPhotoApi({ apiBaseUrl, fetch: fetcher }).getPhotos());
  }
  assert.equal(calls, 0);
});

test("malformed collections, invalid dates, duplicates, and unsafe image URLs are rejected", async () => {
  for (const data of [null, {}, [null], [{ ...photo, id: "" }], [{ ...photo, filename: 42 }],
    [{ ...photo, takenAt: "not a date" }], [photo, photo], [{ ...photo, originalUrl: "javascript:alert(1)" }],
    [{ ...photo, thumbnailUrl: "//unexpected.example.test/photo.jpg" }]]) {
    await assert.rejects(api(data).getPhotos());
  }
  assert.deepEqual(await api([]).getPhotos(), []);
  const older = { ...photo, id: "older", takenAt: "2000-01-01T00:00:00Z" };
  assert.deepEqual((await api([photo, older]).getPhotos()).map(item => item.id), ["abc", "older"]);
});

test("HTTP errors, invalid JSON, network failures, and cancellation reach the caller", async () => {
  await assert.rejects(api({}, { fetch: async () => Response.json({ error: "Collection unavailable" }, { status: 503 }) }).getPhotos(), /Collection unavailable/);
  await assert.rejects(api({}, { fetch: async () => Response.json({}, { status: 404 }) }).getPhotos(), /HTTP 404/);
  await assert.rejects(api({}, { fetch: async () => new Response("<html>error</html>", { status: 502 }) }).getPhotos(), /invalid JSON/);
  await assert.rejects(api({}, { fetch: async () => { throw new Error("Network offline"); } }).getPhotos(), /Network offline/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api({}, { fetch: async (_, options) => { options?.signal?.throwIfAborted(); return Response.json([]); } }).getPhotos({ signal: controller.signal }), { name: "AbortError" });
});
