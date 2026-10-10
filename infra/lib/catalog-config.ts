export const PHOTO_COLLECTION_ID = "default";
export const PHOTO_INDEX_NAME = "collection-date-index";
export const CATALOG_LIMITS = {
  maxItems: 5000,
  maxPages: 50,
  pageSize: 250,
  maxResponseBytes: 4 * 1024 * 1024,
} as const;

/** Media bucket keys and CloudFront paths share this prefix (`/media/*`). */
export const MEDIA_PREFIX = "media";
/** Browser uploads land here in the upload bucket and trigger processing. */
export const INCOMING_PREFIX = "incoming/";
export const PHOTO_WIDTHS = { small: 320, medium: 800, large: 1600 } as const;
export type PhotoTier = keyof typeof PHOTO_WIDTHS;
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const SUPPORTED_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
};
