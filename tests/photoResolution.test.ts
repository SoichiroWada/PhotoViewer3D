import assert from "node:assert/strict";
import { test } from "node:test";
import { createImagePreloader } from "../src/lib/imagePreloader";
import { photoTier, photoVariantUrl, preloadTier } from "../src/lib/photoResolution";

test("distance tiers preload just ahead and use hysteresis on retreat", () => {
  assert.equal(photoTier(2401), "small");
  assert.equal(preloadTier(2400, "small"), "medium");
  assert.equal(photoTier(2001, "small"), "small");
  assert.equal(photoTier(2000, "small"), "medium");
  assert.equal(photoTier(2200, "medium"), "medium");
  assert.equal(photoTier(2401, "medium"), "small");
  assert.equal(preloadTier(801, "medium"), null);
  assert.equal(preloadTier(800, "medium"), "large");
  assert.equal(photoTier(401, "medium"), "medium");
  assert.equal(photoTier(400, "medium"), "large");
  assert.equal(photoTier(600, "large"), "large");
  assert.equal(photoTier(801, "large"), "medium");
  assert.equal(preloadTier(10000, "small"), null);
  assert.equal(preloadTier(-700, "large"), null);
  const photo = { id: "a", filename: "a.jpg", takenAt: "2026-01-01", thumbnailUrl: "/api/photos/a?v=revision&size=small", originalUrl: "/api/photos/a?v=revision&size=original" };
  assert.equal(photoVariantUrl(photo, "large"), "/api/photos/a?v=revision&size=large");
  assert.equal(photoVariantUrl(photo, "original"), photo.originalUrl);
});

test("preloading bounds requests, prioritizes upgrades, shares decodes, and cancels unused work", async () => {
  const images: { src: string; resolve: () => void; reject: (error: Error) => void }[] = [];
  const scheduler = createImagePreloader(2, () => {
    let resolve!: () => void; let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const image = { src: "", resolve, reject, decode: () => promise };
    images.push(image);
    return image as unknown as HTMLImageElement;
  });
  const first = scheduler.request("a"); const second = scheduler.request("b");
  const low = scheduler.request("low"); const high = scheduler.request("high", "high");
  const shared = scheduler.request("a", "high");
  assert.equal(images.length, 2);
  assert.equal(first.promise, shared.promise);
  first.cancel();
  await Promise.resolve();
  assert.equal(images[0].src, "a");
  images[0].resolve(); await shared.promise;
  assert.equal(images[2].src, "high");
  low.cancel(); await assert.rejects(low.promise, /cancelled/);
  second.cancel(); await assert.rejects(second.promise, /cancelled/);
  assert.equal(images[1].src, "");
  images[2].reject(new Error("decode failed")); await assert.rejects(high.promise, /decode failed/);
  assert.equal(images.length, 3);
  const retry = scheduler.request("high"); images[3].resolve(); await retry.promise;
});

test("preload handoff into a required upgrade doesn't restart the network request", async () => {
  let created = 0; let resolve!: () => void;
  const scheduler = createImagePreloader(1, () => {
    created++;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { src: "", decode: () => promise } as unknown as HTMLImageElement;
  });
  const speculative = scheduler.request("large");
  speculative.cancel();
  const required = scheduler.request("large", "high");
  await Promise.resolve();
  assert.equal(created, 1);
  resolve(); await required.promise;
});
