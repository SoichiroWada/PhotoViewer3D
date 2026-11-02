export { getPhotoVariantUrl as photoVariantUrl } from "./api/photoApi";

export const PHOTO_WIDTHS = { small: 320, medium: 800, large: 1600 } as const;
export type PhotoTier = keyof typeof PHOTO_WIDTHS;
export type PhotoSize = PhotoTier | "original";

export function isPhotoSize(value: string): value is PhotoSize {
  return value === "small" || value === "medium" || value === "large" || value === "original";
}

/** Thresholds are independent of card dimensions, projection, and passing. */
export function photoTier(relativeZ: number, current: PhotoTier = "small"): PhotoTier {
  if (relativeZ <= 400 || (current === "large" && relativeZ <= 800)) return "large";
  if (relativeZ <= 2000 || (current !== "small" && relativeZ <= 2400)) return "medium";
  return "small";
}

export function preloadTier(relativeZ: number, current: PhotoTier): PhotoTier | null {
  if (current === "small" && relativeZ <= 2400) return "medium";
  if (current === "medium" && relativeZ <= 800) return "large";
  return null;
}
