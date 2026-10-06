import "server-only";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Photo } from "@/types/photo";

const formats: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp",
};
type Entry = { photo: Photo; filePath: string; contentType: string };
type Catalog = { root: string; entries: Entry[] };
const CACHE_MS = 5_000;
let cache: { directory: string; until: number; pending: Promise<Catalog> } | undefined;

export class PhotoDirectoryError extends Error {}

export function photoId(filename: string): string {
  return createHash("sha256").update(filename).digest("hex").slice(0, 24);
}

/** Single extension point for a future EXIF DateTimeOriginal reader. */
export async function readTakenAt(_filePath: string, modifiedAt: Date): Promise<string> {
  return modifiedAt.toISOString();
}

async function scan(directory: string): Promise<Catalog> {
  const root = await realpath(directory);
  const candidates = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && formats[path.extname(entry.name).toLowerCase()]);
  // Bound stat work rather than opening thousands of files in parallel.
  const entries: Entry[] = [];
  for (let offset = 0; offset < candidates.length; offset += 32) {
    const batch = await Promise.all(candidates.slice(offset, offset + 32).map(async entry => {
      const filePath = path.join(root, entry.name);
      try {
        const info = await stat(filePath);
        const id = photoId(entry.name);
        // Version URLs by mtime and size so replacing an image refreshes the cache.
        const url = `/api/photos/${id}?v=${Math.trunc(info.mtimeMs)}-${info.size}`;
        return {
          filePath,
          contentType: formats[path.extname(entry.name).toLowerCase()],
          photo: {
            id, filename: entry.name, thumbnailUrl: url, originalUrl: url,
            takenAt: await readTakenAt(filePath, info.mtime),
          },
        } satisfies Entry;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }));
    entries.push(...batch.filter((entry): entry is Entry => entry !== null));
  }
  entries.sort((a, b) =>
    Date.parse(b.photo.takenAt) - Date.parse(a.photo.takenAt) ||
    (a.photo.filename < b.photo.filename ? -1 : a.photo.filename > b.photo.filename ? 1 : 0));
  return { root, entries };
}

async function getCatalog(): Promise<Catalog> {
  const directory = process.env.PHOTO_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) {
    throw new PhotoDirectoryError("Set PHOTO_DIRECTORY to an absolute, readable photo directory on the server.");
  }
  if (!cache || cache.directory !== directory || cache.until < Date.now()) {
    const pending = scan(directory);
    const next = { directory, until: Date.now() + CACHE_MS, pending };
    cache = next;
    pending.catch(() => { if (cache === next) cache = undefined; });
  }
  try {
    return await cache.pending;
  } catch {
    throw new PhotoDirectoryError("The photo directory could not be read. Check its path and server permissions.");
  }
}

export async function loadPhotos(): Promise<Photo[]> {
  return (await getCatalog()).entries.map(entry => entry.photo);
}

export async function openPhoto(id: string) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  const { root, entries } = await getCatalog();
  const entry = entries.find(entry => entry.photo.id === id);
  if (!entry) return null;
  try {
    // Reject symlinks, including files replaced by links since the scan.
    const resolved = await realpath(entry.filePath);
    if (path.dirname(resolved) !== root || resolved !== entry.filePath) return null;
    const handle = await open(entry.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) { await handle.close(); return null; }
    return { handle, info, contentType: entry.contentType };
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
