import assert from "node:assert/strict";
import { test } from "node:test";
import { createYearMarkers, nearbyYearMarkers } from "../src/lib/yearMarkers";
import { DEPTH_SPACING } from "../src/lib/photoPosition";

const photos = ["2026-05-01", "2026-02-01", "2012-09-01", "2012-08-01", "2003-06-01"]
  .map(date => ({ takenAt: `${date}T12:00:00.000Z` }));

test("years use actual dates and first chronological photo depth, without inventing missing years", () => {
  assert.deepEqual(createYearMarkers(photos), [
    { year: 2026, photoIndex: 0, photoZ: 0 },
    { year: 2012, photoIndex: 2, photoZ: 2 * DEPTH_SPACING },
    { year: 2003, photoIndex: 4, photoZ: 4 * DEPTH_SPACING },
  ]);
  assert.deepEqual(createYearMarkers([]), []);
  assert.deepEqual(createYearMarkers([{ takenAt: "invalid" }]), []);
});

test("marker years match the displayed local calendar at year boundaries", () => {
  const timestamp = "2025-12-31T23:30:00.000Z";
  assert.equal(createYearMarkers([{ takenAt: timestamp }])[0].year, new Date(timestamp).getFullYear());
});

test("marker window stays aligned with visible photo slots", () => {
  const markers = createYearMarkers(photos);
  assert.deepEqual(nearbyYearMarkers(markers, 1, 4), [markers[1]]);
  assert.deepEqual(nearbyYearMarkers(markers, 4, 5), [markers[2]]);
  assert.deepEqual(nearbyYearMarkers(markers, 5, 6), []);
  assert.deepEqual(nearbyYearMarkers([], 0, 26), []);
});
