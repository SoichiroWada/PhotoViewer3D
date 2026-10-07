import path from "node:path";
import { link } from "node:fs/promises";

export function destinationCandidate(directory: string, filename: string, index: number): string {
  if (path.basename(filename) !== filename || filename === "." || filename === "..") throw new Error("Expected a filename, not a path.");
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid collision index.");
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  return path.join(directory, index ? `${stem}_${index}${extension}` : filename);
}

/** link() publishes atomically and fails with EEXIST; rename() can overwrite. */
export async function publishExclusive(temporaryPath: string, destinationPath: string): Promise<boolean> {
  try { await link(temporaryPath, destinationPath); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}
