import "server-only";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Photo } from "@/types/photo";
import { photoDateReader, type PhotoDateSelection } from "./photoDate";

const formats: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp",
};
type Entry = { photo: Photo; filePath: string; contentType: string; dateSelection: PhotoDateSelection };
type Catalog = { root: string; entries: Entry[] };
const CACHE_MS = 5_000;
let cache: { directory: string; until: number; pending: Promise<Catalog> } | undefined;

export class PhotoDirectoryError extends Error {}

export function photoId(filename: string): string {
  return createHash("sha256").update(filename).digest("hex").slice(0, 24);
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
        const dateSelection = await photoDateReader.read(filePath, info);
        const id = photoId(entry.name);
        // Version URLs by mtime and size so replacing an image refreshes the cache.
        const url = `/api/photos/${id}?v=${Math.trunc(info.mtimeMs)}-${info.size}`;
        return {
          filePath,
          dateSelection,
          contentType: formats[path.extname(entry.name).toLowerCase()],
          photo: {
            id, filename: entry.name, thumbnailUrl: url, originalUrl: url,
            takenAt: dateSelection.takenAt,
          },
        } satisfies Entry;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }));
    entries.push(...batch.filter((entry): entry is Entry => entry !== null));
  }
  photoDateReader.prune(new Set(entries.map(entry => entry.filePath)));
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

/** Server-only development inspection; public Photo JSON stays unchanged. */
export async function loadPhotoDateDiagnostics() {
  return (await getCatalog()).entries.map(entry => ({
    id: entry.photo.id, filename: entry.photo.filename, ...entry.dateSelection,
  }));
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
