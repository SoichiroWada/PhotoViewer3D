export type Photo = {
  id: string;
  filename: string;
  thumbnailUrl: string;
  originalUrl: string;
  /** ISO 8601; EXIF capture date, then mtime, then usable birthtime. */
  takenAt: string;
  /** Pre-rendered sizes (AWS); local endpoints derive sizes from `?size=`. */
  variants?: { small: string; medium: string; large: string };
};
