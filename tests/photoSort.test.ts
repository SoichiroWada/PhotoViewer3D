import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SORT_ORDER, parseSortOrder, sortPhotos } from "../src/lib/photoSort";

const photos = [
  { id: "a", filename: "IMG_10.jpg", takenAt: "2024-05-01T00:00:00.000Z" },
  { id: "b", filename: "img_2.jpg", takenAt: "2025-01-01T00:00:00.000Z" },
  { id: "c", filename: "IMG_1.jpg", takenAt: "2023-03-03T00:00:00.000Z" },
  { id: "d", filename: "beach.png", takenAt: "2025-01-01T00:00:00.000Z" },
];
const ids = (order: Parameters<typeof sortPhotos>[1]) => sortPhotos(photos, order).map(photo => photo.id);

test("default order is newest first, with ties broken by name", () => {
  assert.deepEqual(DEFAULT_SORT_ORDER, { key: "date", direction: "desc" });
  assert.deepEqual(ids(DEFAULT_SORT_ORDER), ["b", "d", "a", "c"]);
  assert.deepEqual(ids({ key: "date", direction: "asc" }), ["c", "a", "d", "b"]);
});

test("names sort naturally and case-insensitively in both directions", () => {
  assert.deepEqual(ids({ key: "name", direction: "asc" }), ["d", "c", "b", "a"]);
  assert.deepEqual(ids({ key: "name", direction: "desc" }), ["a", "b", "c", "d"]);
});

test("sorting does not mutate the input, and unknown stored values fall back to the default", () => {
  const before = photos.map(photo => photo.id);
  sortPhotos(photos, { key: "name", direction: "asc" });
  assert.deepEqual(photos.map(photo => photo.id), before);
  assert.deepEqual(parseSortOrder("name-desc"), { key: "name", direction: "desc" });
  assert.deepEqual(parseSortOrder("bogus"), DEFAULT_SORT_ORDER);
  assert.deepEqual(parseSortOrder(null), DEFAULT_SORT_ORDER);
});
