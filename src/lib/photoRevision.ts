import { createHash } from "node:crypto";
import type { Stats } from "node:fs";

/** ctime and inode also invalidate replacements with preserved mtime/size. */
export function photoRevision(info: Stats): string {
  return createHash("sha256").update(JSON.stringify([
    info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs,
  ])).digest("hex").slice(0, 24);
}
