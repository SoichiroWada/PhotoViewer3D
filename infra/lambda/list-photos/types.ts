/** Catalog records written by the process-photo Lambda. */
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

export type PhotoVariantUrls = { small: string; medium: string; large: string };

// Infrastructure remains independent of frontend compilation; contract tested.
export type PublicPhoto = {
  id: string;
  filename: string;
  thumbnailUrl: string;
  originalUrl: string;
  takenAt: string;
  variants?: PhotoVariantUrls;
};
export type PhotoUrls = { thumbnailUrl: string; originalUrl: string; variants?: PhotoVariantUrls };
export type PhotoUrlResolver = (photo: CatalogPhoto) => PhotoUrls;

export class CatalogLimitError extends Error {}
