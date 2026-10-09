import { PhotoDeliveryUnavailableError, type CatalogPhoto, type PhotoUrlResolver, type PublicPhoto } from "./types";

/** No CloudFront delivery contract exists yet; never substitute public S3 URLs. */
export const unavailablePhotoUrls: PhotoUrlResolver = () => {
  throw new PhotoDeliveryUnavailableError("Photo delivery is not configured yet.");
};

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
  for (const value of [urls.thumbnailUrl, urls.originalUrl]) {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid photo delivery URL.");
  }
  return { id: photo.photoId, filename: photo.filename, thumbnailUrl: urls.thumbnailUrl, originalUrl: urls.originalUrl, takenAt: photo.takenAt };
}
