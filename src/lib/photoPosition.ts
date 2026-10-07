import type { Photo } from "@/types/photo";

export const DEPTH_SPACING = 420;
export const PERSPECTIVE = 900;
export const INITIAL_DEPTH = 300;
export const PASS_FADE_START = -600;
export const PASS_CUTOFF = -800;
// Keep the original timeline extent and decorative wall-label lifecycle.
export const CAMERA_END_PADDING = 1050;
export const UPCOMING = 25;
export const PASSED = 5;
export type Position = { x: number; y: number }; // normalized viewport coordinates

function seededRandom(id: string) {
  let state = 2166136261;
  for (const char of id) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded rejection sampling; no rows, lanes, or randomness during navigation. */
export function createPhotoPositions(photos: Pick<Photo, "id">[]): Map<string, Position> {
  const positions = new Map<string, Position>();
  const recent: Position[] = [];
  for (const photo of photos) {
    const random = seededRandom(photo.id);
    let best = { x: 0, y: 0 };
    let bestDistance = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = { x: (random() * 2 - 1) * 0.86, y: (random() * 2 - 1) * 0.8 };
      const distance = Math.min(...recent.map(p => Math.hypot(candidate.x - p.x, candidate.y - p.y)));
      if (distance > bestDistance) { best = candidate; bestDistance = distance; }
      if (distance > 0.54) break;
    }
    positions.set(photo.id, best);
    recent.push(best);
    if (recent.length > 3) recent.shift();
  }
  return positions;
}

export function cameraLimit(count: number): number {
  return count === 0 ? 0 : (count - 1) * DEPTH_SPACING + CAMERA_END_PADDING;
}
export function clampCamera(value: number, count: number): number {
  return Math.max(0, Math.min(cameraLimit(count), value));
}
export function wheelDistance(deltaY: number, mode: number, viewportHeight: number): number {
  const pixels = deltaY * (mode === 1 ? 16 : mode === 2 ? viewportHeight : 1);
  return Math.max(-700, Math.min(700, pixels * 1.5));
}
export function cameraStep(current: number, target: number, elapsedMs: number): number {
  const next = current + (target - current) * (1 - Math.exp(-Math.min(elapsedMs, 64) / 95));
  return Math.abs(target - next) < 0.1 ? target : next;
}
function projectedDepth(index: number, cameraZ: number, fadeStart: number, cutoff: number) {
  const relativeZ = index * DEPTH_SPACING - cameraZ;
  const passedOpacity = relativeZ < fadeStart ? Math.max(0, (relativeZ - cutoff) / (fadeStart - cutoff)) : 1;
  return {
    relativeZ,
    translateZ: -(relativeZ + INITIAL_DEPTH),
    opacity: Math.max(0.14, 1 - Math.max(0, relativeZ) / 14000) * passedOpacity,
    brightness: Math.max(0.6, 1 - Math.max(0, relativeZ) / 20000),
    visible: relativeZ > cutoff,
  };
}
export function photoDepth(index: number, cameraZ: number) {
  return projectedDepth(index, cameraZ, PASS_FADE_START, PASS_CUTOFF);
}
/** Wall years retain their existing fade, depth, and visibility distances. */
export function yearDepth(index: number, cameraZ: number) {
  return projectedDepth(index, cameraZ, -750, -1050);
}
export function visibleWindow(count: number, cameraZ: number) {
  const current = Math.max(0, Math.min(count - 1, Math.floor(cameraZ / DEPTH_SPACING)));
  return { start: Math.max(0, current - PASSED), end: Math.min(count, current + UPCOMING + 1) };
}
