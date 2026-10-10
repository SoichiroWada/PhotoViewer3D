import type { CatalogPhoto, PhotoUrlResolver, PublicPhoto } from "./types";

/** Same-origin CloudFront paths; `/media/*` requires the signed session cookies. */
export const mediaPhotoUrls: PhotoUrlResolver = photo => {
  const path = (key: string | undefined) => {
    if (!key) throw new Error("Catalog photo is missing a media key.");
    if (!key.startsWith("media/") || key.includes("..")) throw new Error("Invalid catalog media key.");
    return "/" + key.split("/").map(encodeURIComponent).join("/");
  };
  const variants = { small: path(photo.smallKey), medium: path(photo.mediumKey), large: path(photo.largeKey) };
  return { thumbnailUrl: variants.small, originalUrl: path(photo.originalKey), variants };
};

function validUrl(value: string) {
  if (value.startsWith("/") && !value.startsWith("//")) return;
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid photo delivery URL.");
}

export function toPublicPhoto(item: Record<string, unknown>, resolveUrls: PhotoUrlResolver): PublicPhoto {
  for (const key of ["photoId", "collectionId", "takenAtKey", "filename", "takenAt", "originalKey"]) {
    if (typeof item[key] !== "string" || !item[key]) throw new Error(`Invalid catalog attribute: ${key}`);
  }
  const photo = item as unknown as CatalogPhoto;
  const date = new Date(photo.takenAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== photo.takenAt || photo.takenAtKey !== `${photo.takenAt}#${photo.photoId}`) {
    throw new Error("Invalid catalog date or chronological key.");
  }
  const urls = resolveUrls(photo);
  for (const value of [urls.thumbnailUrl, urls.originalUrl, ...Object.values(urls.variants ?? {})]) validUrl(value);
  return { id: photo.photoId, filename: photo.filename, thumbnailUrl: urls.thumbnailUrl, originalUrl: urls.originalUrl,
    takenAt: photo.takenAt, ...(urls.variants ? { variants: urls.variants } : {}) };
}
