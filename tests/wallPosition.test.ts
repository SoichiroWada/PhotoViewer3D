import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPTH_SPACING, PERSPECTIVE } from "../src/lib/photoPosition";
import {
  createWallPositions, WALL_ARC, WALL_ARC_LENGTH, WALL_ARM, WALL_CARD, WALL_FRONT_SCALE, WALL_FRONT_Z, WALL_LAYER,
  WALL_REACH, WALL_SPACING, WALL_Y_RANGE, wallOutline, wallPlacement, wallPose, wallProject, wallWindow,
} from "../src/lib/wallPosition";

const still = { y: 0, jitter: 0, layer: 0 };
const photos = Array.from({ length: 2000 }, (_, index) => ({ id: `photo-${index}` }));

test("wall positions are seeded, stable, and spread over the whole belt height", () => {
  const first = createWallPositions(photos);
  assert.deepEqual(first, createWallPositions(photos));
  const [low, high] = WALL_Y_RANGE;
  for (const p of first.values()) {
    assert.ok(p.y >= low && p.y <= high);
    assert.ok(Math.abs(p.jitter) <= .3);
    assert.ok(p.layer === 0 || p.layer === 1);
  }
  const ys = [...first.values()].map(p => p.y);
  const third = (high - low) / 3;
  assert.ok(ys.filter(y => y < low + third).length > 500 && ys.filter(y => y > high - third).length > 500);
  // Overlaps are rare.
  assert.ok([...first.values()].filter(p => p.layer > 0).length < photos.length * .02);
});

test("the belt wraps a wide drum, runs straight on both sides, and ends at the chosen height", () => {
  const front = wallPose(0);
  assert.deepEqual([front.x, front.z, front.angle], [0, WALL_FRONT_Z, 0]);
  assert.ok(wallPose(-500).x < 0 && wallPose(500).x > 0);
  for (const side of [-1, 1]) {
    const edge = wallPose(side * WALL_ARC_LENGTH);
    const beyond = wallPose(side * (WALL_ARC_LENGTH + 1));
    assert.ok(Math.hypot(edge.x - beyond.x, edge.z - beyond.z) < 1.01);
    assert.ok(Math.abs(edge.angle - side * WALL_ARC) < 1e-9);
  }
  // Wider than deep: the front stays flatter than a circle through the same edge.
  const edge = wallPose(WALL_ARC_LENGTH);
  assert.ok(edge.x > 2 * (WALL_FRONT_Z - edge.z));
  // The straight runs recede yet keep facing the viewer, so the wall is never seen from behind.
  for (const u of [-WALL_ARC_LENGTH - WALL_ARM, -3000, 3000, WALL_ARC_LENGTH + WALL_ARM]) {
    assert.ok(wallPose(u).shade > .72);
  }
  const end = wallPose(WALL_ARC_LENGTH + WALL_ARM);
  assert.ok(Math.abs(PERSPECTIVE / (PERSPECTIVE - end.z) / WALL_FRONT_SCALE - .09) < 1e-9);
  // The projected outline runs left to right without folding back, from one cut end to the other.
  const outline = wallOutline().map(u => wallProject(u, 0).x);
  assert.equal(wallOutline()[0], -WALL_ARC_LENGTH - WALL_ARM);
  for (let index = 1; index < outline.length; index++) assert.ok(outline[index] > outline[index - 1]);
});

test("the newest photo starts left and the wall slides left toward the past", () => {
  const newest = wallPlacement(0, 0, still);
  assert.ok(newest.pose.x < 0);
  assert.ok(wallPlacement(3, 0, still).pose.x > newest.pose.x);
  const later = wallPlacement(0, DEPTH_SPACING, still);
  assert.equal(newest.u - later.u, WALL_SPACING);
  assert.deepEqual(wallPlacement(1, DEPTH_SPACING, still), newest);
  assert.equal(wallPlacement(0, 10000 * DEPTH_SPACING, still).visible, false);
  assert.ok(wallPlacement(0, 0, still).relativeZ < wallPlacement(15, 0, still).relativeZ);
  assert.ok(wallPlacement(0, 0, { ...still, layer: 1 }).pose.z - newest.pose.z > WALL_LAYER * .5);
});

// Height of a card's flat plane above the belt at belt position u.
function heightAbove(u: number, card: ReturnType<typeof wallPlacement>) {
  const belt = wallPose(u);
  const n = [Math.sin(card.pose.angle), Math.cos(card.pose.angle)];
  const m = [Math.sin(belt.angle), Math.cos(belt.angle)];
  return (n[0] * (card.pose.x - belt.x) + n[1] * (card.pose.z - belt.z)) / (n[0] * m[0] + n[1] * m[1]);
}

test("overlapping cards never cut through each other: one stays on top across the overlap", () => {
  const positions = createWallPositions(photos);
  let checked = 0;
  for (const camera of [0, 37 * DEPTH_SPACING, 400 * DEPTH_SPACING, 1290 * DEPTH_SPACING]) {
    const { start, end } = wallWindow(photos.length, camera);
    const cards = photos.slice(start, end).map((photo, offset) => ({
      ...wallPlacement(start + offset, camera, positions.get(photo.id)!), y: positions.get(photo.id)!.y,
    })).filter(card => card.visible);
    for (const a of cards) for (const b of cards) {
      if (a.u >= b.u || b.u - a.u >= WALL_CARD.width || Math.abs(a.y - b.y) >= WALL_CARD.height) continue;
      checked++;
      const signs = new Set<number>();
      for (let u = b.u - WALL_CARD.width / 2; u <= a.u + WALL_CARD.width / 2; u += 5) signs.add(Math.sign(heightAbove(u, a) - heightAbove(u, b)));
      assert.equal(signs.size, 1, `cards at ${a.u.toFixed(0)} and ${b.u.toFixed(0)} cross`);
    }
  }
  assert.ok(checked > 0);
});

test("wall DOM windows stay bounded and cover every visible photo", () => {
  for (const camera of [0, 1, 42000, 999999 * DEPTH_SPACING]) {
    const { start, end } = wallWindow(1000000, camera);
    assert.ok(start >= 0 && end <= 1000000 && end - start <= 2 * WALL_REACH / WALL_SPACING + 6);
    for (const index of [start - 1, end]) {
      if (index >= 0 && index < 1000000) assert.equal(wallPlacement(index, camera, { ...still, jitter: index < start ? .3 : -.3 }).visible, false);
    }
  }
  assert.deepEqual(wallWindow(0, 0), { start: 0, end: 0 });
});
