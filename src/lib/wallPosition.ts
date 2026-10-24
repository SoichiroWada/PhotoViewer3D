import type { Photo } from "@/types/photo";
import { DEPTH_SPACING, PERSPECTIVE, seededRandom } from "./photoPosition";

/*
 * The wall is one continuous belt seen from above as a "U": it wraps the front
 * of a wide elliptical drum facing the viewer, then runs straight away on both
 * sides and ends with a vertical cut. Newer photos lie to the left, older ones
 * to the right, and travelling back in time slides the belt to the left. Belt
 * coordinate `u` is the distance along the belt from the drum's front point
 * (negative is left).
 */
export const WALL_SPACING = 240; // belt length per photo
export const WALL_HALF_WIDTH = 1100; // drum semi-axis across the view
export const WALL_HALF_DEPTH = 600; // drum semi-axis into the view
export const WALL_FRONT_Z = -350;
export const WALL_ARC = 50 * Math.PI / 180; // facing angle where the belt leaves the drum and runs straight
export const WALL_HEIGHT = 1100;
export const WALL_CARD = { width: 390, height: 300 }; // see .photo-card--wall
export const WALL_Y_RANGE = [-295, 375] as const; // card centres; the band above holds the year labels
export const WALL_LAYER = 40; // extra lift per overlap layer, so overlapping cards never cut through each other
export const WALL_FOCUS = 400; // the current photo sits this far left of the front
/** Projected height of the belt's front as a fraction of WALL_HEIGHT; used to fit the stage. */
export const WALL_FRONT_SCALE = PERSPECTIVE / (PERSPECTIVE - WALL_FRONT_Z);
// The cut ends appear at this fraction of the front's height (2–3 cm on a 27" monitor).
const END_RATIO = 0.09;
const GAP = 16;
const CENTER_Z = WALL_FRONT_Z - WALL_HALF_DEPTH;

// Arc length along the ellipse from the front, sampled by its parameter t (x = a sin t, z = b cos t).
const T_MAX = Math.atan(WALL_HALF_WIDTH / WALL_HALF_DEPTH * Math.tan(WALL_ARC));
const SAMPLES = 512;
const ARC_TABLE = (() => {
  const lengths = [0];
  for (let step = 1; step <= SAMPLES; step++) {
    const t = T_MAX * (step - 0.5) / SAMPLES;
    lengths.push(lengths[step - 1] + Math.hypot(WALL_HALF_WIDTH * Math.cos(t), WALL_HALF_DEPTH * Math.sin(t)) * T_MAX / SAMPLES);
  }
  return lengths;
})();
export const WALL_ARC_LENGTH = ARC_TABLE[SAMPLES];
const EDGE = { x: WALL_HALF_WIDTH * Math.sin(T_MAX), z: CENTER_Z + WALL_HALF_DEPTH * Math.cos(T_MAX) };
/** Straight run on each side, long enough to shrink to END_RATIO of the front's height. */
export const WALL_ARM = (EDGE.z - PERSPECTIVE + PERSPECTIVE / (WALL_FRONT_SCALE * END_RATIO)) / Math.sin(WALL_ARC);
// Photos stop well before the cut, where they have shrunk to thumbnails.
export const WALL_REACH = WALL_ARC_LENGTH + 7000;
const FADE = 1500;

export type WallPosition = { y: number; jitter: number; layer: number }; // y in px, jitter in photo spacings
export type WallPose = { x: number; z: number; angle: number; shade: number };

function arcParameter(length: number) {
  let low = 0;
  let high = SAMPLES;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (ARC_TABLE[middle] <= length) low = middle;
    else high = middle;
  }
  const fraction = (length - ARC_TABLE[low]) / (ARC_TABLE[high] - ARC_TABLE[low]);
  return T_MAX * (low + fraction) / SAMPLES;
}

function overlap(a: { u: number; y: number }, b: { u: number; y: number }, pad: number) {
  return Math.max(0, WALL_CARD.width + pad - Math.abs(a.u - b.u)) * Math.max(0, WALL_CARD.height + pad - Math.abs(a.y - b.y));
}

/**
 * Seeded and stable like the corridor. Each photo tries spots around its place
 * in time over the full belt height and keeps the first one clear of its
 * neighbours (or the least covered). A photo that still overlaps one is lifted
 * to the next layer, so one of the two always lies cleanly on top.
 */
export function createWallPositions(photos: Pick<Photo, "id">[]): Map<string, WallPosition> {
  const positions = new Map<string, WallPosition>();
  const recent: { u: number; y: number; layer: number }[] = [];
  const [low, high] = WALL_Y_RANGE;
  photos.forEach((photo, index) => {
    const random = seededRandom(photo.id);
    let best = { u: 0, y: 0, jitter: 0 };
    let bestCover = Infinity;
    for (let attempt = 0; attempt < 24; attempt++) {
      const jitter = (random() * 2 - 1) * 0.3;
      const candidate = { u: (index + jitter) * WALL_SPACING, y: low + random() * (high - low), jitter };
      const cover = recent.reduce((sum, entry) => sum + overlap(candidate, entry, GAP), 0);
      if (cover < bestCover) { best = candidate; bestCover = cover; }
      if (cover === 0) break;
    }
    const covered = recent.filter(entry => overlap(best, entry, 0) > 0);
    let layer = 0;
    while (covered.some(entry => entry.layer === layer)) layer++;
    positions.set(photo.id, { y: best.y, jitter: best.jitter, layer });
    recent.push({ u: best.u, y: best.y, layer });
    if (recent.length > 6) recent.shift();
  });
  return positions;
}

/** How far the belt has slid left for a timeline position. */
export function wallShift(cameraZ: number): number {
  return cameraZ / DEPTH_SPACING * WALL_SPACING;
}

/** Where a point on the belt is, which way it faces, and how much light it catches. `lift` moves it off the surface. */
export function wallPose(u: number, lift = 0): WallPose {
  const side = u < 0 ? -1 : 1;
  let x: number;
  let z: number;
  let angle: number;
  if (Math.abs(u) <= WALL_ARC_LENGTH) {
    const t = arcParameter(Math.abs(u));
    x = side * WALL_HALF_WIDTH * Math.sin(t);
    z = CENTER_Z + WALL_HALF_DEPTH * Math.cos(t);
    angle = side * Math.atan2(WALL_HALF_DEPTH * Math.sin(t), WALL_HALF_WIDTH * Math.cos(t));
  } else {
    // Beyond the drum the belt continues along its tangent.
    const along = Math.abs(u) - WALL_ARC_LENGTH;
    x = side * (EDGE.x + along * Math.cos(WALL_ARC));
    z = EDGE.z - along * Math.sin(WALL_ARC);
    angle = side * WALL_ARC;
  }
  x += lift * Math.sin(angle);
  z += lift * Math.cos(angle);
  const toViewer = Math.hypot(x, PERSPECTIVE - z);
  const facing = (-x * Math.sin(angle) + (PERSPECTIVE - z) * Math.cos(angle)) / toViewer;
  return { x, z, angle, shade: 0.72 + 0.28 * Math.max(0, facing) };
}

export function wallPlacement(index: number, cameraZ: number, position: WallPosition) {
  const u = (index + position.jitter) * WALL_SPACING - wallShift(cameraZ) - WALL_FOCUS;
  const pose = wallPose(u, 4 + position.layer * WALL_LAYER);
  return {
    u, pose,
    y: position.y,
    visible: Math.abs(u) < WALL_REACH,
    opacity: Math.max(0, Math.min(1, (WALL_REACH - Math.abs(u)) / FADE)),
    // Resolution follows distance: the front of the drum asks for medium, the far belt for small.
    relativeZ: 600 + WALL_FRONT_Z - pose.z,
  };
}

/** Belt position of a photo index ignoring its jitter, e.g. for year labels. */
export function wallIndexU(index: number, cameraZ: number): number {
  return index * WALL_SPACING - wallShift(cameraZ) - WALL_FOCUS;
}

export function wallWindow(count: number, cameraZ: number) {
  const center = (wallShift(cameraZ) + WALL_FOCUS) / WALL_SPACING; // photo index at the front
  const reach = WALL_REACH / WALL_SPACING + 1;
  return { start: Math.max(0, Math.floor(center - reach)), end: Math.max(0, Math.min(count, Math.ceil(center + reach) + 1)) };
}

/** Screen offset from the stage centre of a belt point, before the stage scale. Belt edges stay straight vertically. */
export function wallProject(u: number, y: number) {
  const pose = wallPose(u);
  const factor = PERSPECTIVE / (PERSPECTIVE - pose.z);
  return { x: pose.x * factor, y: y * factor, shade: pose.shade };
}

/** Belt positions that trace the outline: dense around the drum, sparse along the straight runs. */
export function wallOutline(step = 30, armSamples = 8): number[] {
  const end = WALL_ARC_LENGTH + WALL_ARM;
  const points: number[] = [];
  for (let sample = 0; sample <= armSamples; sample++) points.push(-end + WALL_ARM * sample / armSamples);
  const slices = Math.ceil(2 * WALL_ARC_LENGTH / step);
  for (let slice = 1; slice < slices; slice++) points.push(-WALL_ARC_LENGTH + 2 * WALL_ARC_LENGTH * slice / slices);
  for (let sample = 0; sample <= armSamples; sample++) points.push(WALL_ARC_LENGTH + WALL_ARM * sample / armSamples);
  return points;
}
