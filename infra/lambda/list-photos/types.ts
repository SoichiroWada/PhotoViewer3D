/** Future catalog records; optional processing fields are not needed by Phase 2. */
export interface CatalogPhoto {
  photoId: string;
  collectionId: string;
  takenAtKey: string;
  filename: string;
  takenAt: string;
  originalKey: string;
  smallKey?: string;
  mediumKey?: string;
  largeKey?: string;
  dateSource?: string;
  sha256?: string;
  width?: number;
  height?: number;
}

// Infrastructure remains independent of frontend compilation; contract tested.
export type PublicPhoto = {
  id: string;
  filename: string;
  thumbnailUrl: string;
  originalUrl: string;
  takenAt: string;
};
export type PhotoUrlResolver = (photo: CatalogPhoto) => { thumbnailUrl: string; originalUrl: string };

export class CatalogLimitError extends Error {}
export class PhotoDeliveryUnavailableError extends Error {}
