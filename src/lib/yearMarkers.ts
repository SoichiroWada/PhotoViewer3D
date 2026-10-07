import type { Photo } from "@/types/photo";
import { DEPTH_SPACING } from "./photoPosition";

export type YearMarker = { year: number; photoIndex: number; photoZ: number };

/** The start of each actual year in the already-sorted photo timeline. */
export function createYearMarkers(photos: Pick<Photo, "takenAt">[]): YearMarker[] {
  const markers: YearMarker[] = [];
  let previousYear: number | undefined;
  photos.forEach((photo, photoIndex) => {
    // Match the local-calendar dates displayed on photo cards and the timeline.
    const year = new Date(photo.takenAt).getFullYear();
    if (!Number.isFinite(year)) return;
    if (year !== previousYear) {
      markers.push({ year, photoIndex, photoZ: photoIndex * DEPTH_SPACING });
      previousYear = year;
    }
  });
  return markers;
}

/** Binary search avoids scanning every year's marker on every animation frame. */
export function nearbyYearMarkers(markers: YearMarker[], start: number, end: number): YearMarker[] {
  let low = 0;
  let high = markers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (markers[middle].photoIndex < start) low = middle + 1;
    else high = middle;
  }
  const nearby: YearMarker[] = [];
  for (let index = low; index < markers.length && markers[index].photoIndex < end; index++) {
    nearby.push(markers[index]);
  }
  return nearby;
}
