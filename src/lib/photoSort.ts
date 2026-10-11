import type { Photo } from "@/types/photo";

export type PhotoSortKey = "date" | "name";
export type PhotoSortDirection = "asc" | "desc";
export type PhotoSortOrder = { key: PhotoSortKey; direction: PhotoSortDirection };

/** Newest first: the latest photo sits at the top left of the grid. */
export const DEFAULT_SORT_ORDER: PhotoSortOrder = { key: "date", direction: "desc" };

export const SORT_OPTIONS: { value: string; label: string; order: PhotoSortOrder }[] = [
  { value: "date-desc", label: "Date (newest first)", order: { key: "date", direction: "desc" } },
  { value: "date-asc", label: "Date (oldest first)", order: { key: "date", direction: "asc" } },
  { value: "name-asc", label: "Name (A → Z)", order: { key: "name", direction: "asc" } },
  { value: "name-desc", label: "Name (Z → A)", order: { key: "name", direction: "desc" } },
];

export const sortOrderValue = (order: PhotoSortOrder) => `${order.key}-${order.direction}`;

export function parseSortOrder(value: string | null | undefined): PhotoSortOrder {
  return SORT_OPTIONS.find(option => option.value === value)?.order ?? DEFAULT_SORT_ORDER;
}

// Numeric collation matches Explorer: IMG_2 comes before IMG_10.
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * `takenAt` is already the EXIF capture date with the modified time as its fallback.
 * Ties fall back to the other key, then the ID, so the order is stable.
 */
export function sortPhotos<T extends Pick<Photo, "id" | "filename" | "takenAt">>(photos: readonly T[], order: PhotoSortOrder): T[] {
  const sign = order.direction === "asc" ? 1 : -1;
  const byDate = (a: T, b: T) => Date.parse(a.takenAt) - Date.parse(b.takenAt);
  const byName = (a: T, b: T) => names.compare(a.filename, b.filename);
  const [primary, secondary] = order.key === "date" ? [byDate, byName] : [byName, byDate];
  return [...photos].sort((a, b) =>
    sign * (primary(a, b) || secondary(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}
