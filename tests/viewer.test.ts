import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cameraLimit, cameraStep, clampCamera, createPhotoPositions, DEPTH_SPACING,
  INITIAL_DEPTH, PASS_CUTOFF, photoDepth, PERSPECTIVE, visibleWindow, wheelDistance,
} from "../src/lib/photoPosition";

test("ID-seeded positions remain stable, scattered, and bounded", () => {
  const photos = Array.from({ length: 1000 }, (_, index) => ({ id: `photo-${index}` }));
  const first = createPhotoPositions(photos);
  assert.deepEqual(first, createPhotoPositions(photos));
  for (const p of first.values()) { assert.ok(Math.abs(p.x) <= .86); assert.ok(Math.abs(p.y) <= .8); }
  assert.ok([...first.values()].some(p => Math.abs(p.x) < .2 && Math.abs(p.y) < .2));
  assert.ok(new Set([...first.values()].map(p => p.y)).size > 990);
});

test("chronological depth approaches, enlarges, and disappears after passing", () => {
  const index = 6;
  const far = photoDepth(index, 0);
  const near = photoDepth(index, index * DEPTH_SPACING);
  const foreground = photoDepth(index, index * DEPTH_SPACING + 850);
  const scale = (z: number) => PERSPECTIVE / (PERSPECTIVE - z);
  assert.ok(scale(far.translateZ) < scale(near.translateZ));
  assert.ok(scale(near.translateZ) < scale(foreground.translateZ));
  assert.equal(near.translateZ, -INITIAL_DEPTH);
  assert.ok(far.opacity < near.opacity);
  assert.equal(photoDepth(index, index * DEPTH_SPACING - PASS_CUTOFF).visible, false);
  assert.ok(photoDepth(index + 1, index * DEPTH_SPACING - PASS_CUTOFF).visible);
});

test("continuous wheel input and smooth time-based interpolation", () => {
  assert.equal(wheelDistance(1, 0, 800), 1.5);
  assert.equal(wheelDistance(2, 0, 800), 3);
  assert.equal(wheelDistance(-10, 0, 800), -15);
  assert.equal(wheelDistance(1, 1, 800), 24);
  assert.equal(wheelDistance(1, 2, 800), 700);
  const first = cameraStep(0, 420, 16);
  assert.ok(first > 0 && first < 420);
  assert.ok(Math.abs(cameraStep(cameraStep(0, 420, 16), 420, 16) - cameraStep(0, 420, 32)) < .00001);
  assert.equal(clampCamera(-20, 100), 0);
  assert.equal(clampCamera(1000000, 100), cameraLimit(100));
  assert.equal(cameraLimit(0), 0);
});

test("DOM windows stay bounded even for a million photos", () => {
  for (const camera of [0, 1, 42000, 999999 * DEPTH_SPACING]) {
    const { start, end } = visibleWindow(1000000, camera);
    assert.ok(start >= 0 && end <= 1000000);
    assert.ok(end - start <= 31);
  }
  assert.deepEqual(visibleWindow(0, 0), { start: 0, end: 0 });
});
