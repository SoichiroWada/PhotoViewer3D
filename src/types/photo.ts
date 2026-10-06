export type Photo = {
  id: string;
  filename: string;
  thumbnailUrl: string;
  originalUrl: string;
  /** ISO 8601; filesystem mtime for Phase 1, capture metadata later. */
  takenAt: string;
};
