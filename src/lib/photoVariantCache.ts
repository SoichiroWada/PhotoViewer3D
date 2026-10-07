import "server-only";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, type Stats } from "node:fs";
import { mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { PHOTO_WIDTHS, type PhotoTier } from "./photoResolution";
import { photoRevision } from "./photoRevision";

// Changing these settings must change the recipe, so old outputs aren't reused.
const RECIPE = "v1-webp90-lanczos3-oriented-" + sharp.versions.sharp;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
sharp.cache({ memory: 32, files: 0, items: 32 });
sharp.concurrency(2);

export function createResizeLimiter(concurrency = 2, maxWaiting = 64) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      if (waiting.length >= maxWaiting) throw new Error("Photo resize queue is full; try again later.");
      await new Promise<void>(resolve => waiting.push(resolve));
    } else active++;
    try { return await task(); }
    finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}

const runResize = createResizeLimiter();
const pending = new Map<string, Promise<void>>();
export type VariantSource = { handle: FileHandle; info: Stats; root: string };

function inside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function cacheDirectory(sourceRoot: string): Promise<string> {
  const directory = process.env.PHOTO_CACHE_DIRECTORY || path.join(process.cwd(), ".photo-cache");
  if (!path.isAbsolute(directory)) throw new Error("PHOTO_CACHE_DIRECTORY must be an absolute path.");
  // Runtime cache files are not application assets for Next's output tracing.
  if (inside(sourceRoot, path.resolve(/* turbopackIgnore: true */ directory))) throw new Error("Photo cache must be outside the original photo directory.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(/* turbopackIgnore: true */ directory);
  if (inside(sourceRoot, root)) throw new Error("Photo cache resolves inside the original photo directory.");
  return root;
}

async function openCached(filePath: string) {
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) { await handle.close(); return null; }
    return { handle, info, contentType: "image/webp" };
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

async function ensureUnchanged(source: VariantSource, revision: string) {
  if (photoRevision(await source.handle.stat()) !== revision) throw new Error("Photo changed during image generation; retry with the refreshed catalog.");
}

/** Caller retains ownership of the opened original, including on failure. */
export async function openPhotoVariant(id: string, tier: PhotoTier, source: VariantSource) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid photo cache ID.");
  const revision = photoRevision(source.info);
  const rootHash = createHash("sha256").update(source.root).digest("hex").slice(0, 24);
  const directory = path.join(await cacheDirectory(source.root), RECIPE, rootHash, id, revision);
  const target = path.join(directory, `${tier}.webp`);
  const existing = await openCached(target);
  if (existing) {
    try { await ensureUnchanged(source, revision); return { ...existing, etag: `"${RECIPE}-${tier}-${revision}"` }; }
    catch (error) { await existing.handle.close(); throw error; }
  }
  let generation = pending.get(target);
  if (!generation) {
    generation = runResize(async () => {
      // A second process may have populated the disk cache while we queued.
      const cached = await openCached(target);
      if (cached) { await cached.handle.close(); return; }
      await ensureUnchanged(source, revision);
      if (source.info.size > MAX_SOURCE_BYTES) throw new Error("Photo is too large for bounded variant generation; original remains available.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.${tier}-${randomUUID()}.tmp`);
      try {
        const transform = sharp({ limitInputPixels: 80_000_000, sequentialRead: true })
          .autoOrient()
          .resize({ width: PHOTO_WIDTHS[tier], withoutEnlargement: true, kernel: "lanczos3", fastShrinkOnLoad: false })
          .webp({ quality: 90, effort: 4, smartSubsample: true });
        // Numeric fd stream doesn't own or retain FileHandle references.
        await pipeline(
          createReadStream("", { fd: source.handle.fd, start: 0, autoClose: false }),
          transform,
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
        await ensureUnchanged(source, revision);
        await rename(temporary, target); // only complete cache files become visible
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== "ENOENT") console.error("Variant temp cleanup failed:", error); });
      }
    });
    pending.set(target, generation);
    void generation.finally(() => { if (pending.get(target) === generation) pending.delete(target); }).catch(() => {});
  }
  await generation;
  await ensureUnchanged(source, revision);
  const variant = await openCached(target);
  if (!variant) throw new Error("Generated photo variant is unavailable.");
  return { ...variant, etag: `"${RECIPE}-${tier}-${revision}"` };
}
