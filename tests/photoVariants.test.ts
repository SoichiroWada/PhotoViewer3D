import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openPhotoVariant, createResizeLimiter } from "../src/lib/photoVariantCache";
import { photoRevision } from "../src/lib/photoRevision";
import { photoId } from "../src/lib/photoLoader";
import { GET } from "../src/app/api/photos/[id]/route";
import type { PhotoTier } from "../src/lib/photoResolution";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "photo-variants-"));
  const photos = path.join(root, "photos"); const cache = path.join(root, "cache");
  await mkdir(photos);
  const previousPhoto = process.env.PHOTO_DIRECTORY;
  const previousCache = process.env.PHOTO_CACHE_DIRECTORY;
  process.env.PHOTO_DIRECTORY = photos; process.env.PHOTO_CACHE_DIRECTORY = cache;
  return { root, photos, cache, async cleanup() {
    if (previousPhoto === undefined) delete process.env.PHOTO_DIRECTORY; else process.env.PHOTO_DIRECTORY = previousPhoto;
    if (previousCache === undefined) delete process.env.PHOTO_CACHE_DIRECTORY; else process.env.PHOTO_CACHE_DIRECTORY = previousCache;
    await rm(root, { recursive: true, force: true });
  } };
}
const image = (width = 4000, height = 3000, color = "#3f719a") => sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
async function variant(file: string, root: string, tier: PhotoTier) {
  const handle = await open(file, "r");
  try { return await openPhotoVariant(photoId(path.basename(file)), tier, { handle, info: await handle.stat(), root }); }
  finally { await handle.close(); }
}

test("variants preserve aspect ratio, originals, and disk cache across repeated concurrent requests", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.photos, "My Photo.JPG"); const bytes = await image();
    await writeFile(file, bytes); const original = await stat(file);
    const cold = await Promise.all(Array.from({ length: 6 }, () => variant(file, f.photos, "small")));
    assert.equal(new Set(cold.map(result => result.info.ino)).size, 1);
    for (const result of cold) await result.handle.close();
    for (const [tier, width] of [["small", 320], ["medium", 800], ["large", 1600]] as const) {
      const result = await variant(file, f.photos, tier);
      const metadata = await sharp(await result.handle.readFile()).metadata();
      assert.equal(metadata.width, width); assert.equal(metadata.height, width * .75);
      assert.equal(metadata.format, "webp"); await result.handle.close();
    }
    const results = await Promise.all(Array.from({ length: 6 }, () => variant(file, f.photos, "medium")));
    assert.equal(new Set(results.map(result => result.info.ino)).size, 1);
    for (const result of results) await result.handle.close();
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await stat(file)).mtimeMs, original.mtimeMs);
    const paths = await readdir(f.cache, { recursive: true });
    assert.equal(paths.filter(name => name.endsWith(".webp")).length, 3);
    assert.ok(!paths.some(name => name.endsWith(".tmp")));
  } finally { await f.cleanup(); }
});

test("orientation is applied without enlargement, cropping, or changing original metadata", async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: "red" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const file = path.join(f.photos, "rotated.jpg"); await writeFile(file, bytes);
    const result = await variant(file, f.photos, "large");
    const metadata = await sharp(await result.handle.readFile()).metadata();
    assert.equal(metadata.width, 400); assert.equal(metadata.height, 600);
    assert.equal(metadata.orientation, undefined); await result.handle.close();
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await sharp(file).metadata()).orientation, 6);
  } finally { await f.cleanup(); }
});

test("source revisions invalidate cache even when file size and modification time are preserved", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.photos, "replaced.png");
    const bytes = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "red" } }).png({ compressionLevel: 0 }).toBuffer();
    await writeFile(file, bytes);
    const before = await stat(file); const initialRevision = photoRevision(before);
    const first = await variant(file, f.photos, "small"); const firstBytes = await first.handle.readFile(); await first.handle.close();
    const newBytes = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "blue" } }).png({ compressionLevel: 0 }).toBuffer();
    assert.equal(newBytes.length, bytes.length);
    await new Promise(resolve => setTimeout(resolve, 15));
    await writeFile(file, newBytes); await utimes(file, before.atime, before.mtime);
    const after = await stat(file);
    assert.equal(after.size, before.size); assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) < 1);
    assert.notEqual(photoRevision(after), initialRevision);
    const next = await variant(file, f.photos, "small");
    assert.notEqual(next.etag, first.etag); assert.notDeepEqual(await next.handle.readFile(), firstBytes); await next.handle.close();
    const stale = await open(file, "r");
    try { await assert.rejects(openPhotoVariant(photoId("replaced.png"), "small", { handle: stale, info: before, root: f.photos }), /changed/); }
    finally { await stale.close(); }
  } finally { await f.cleanup(); }
});

test("image endpoint validates sizes, streams unchanged originals, and revalidates each variant separately", async () => {
  const f = await fixture();
  try {
    const filename = "endpoint.jpg"; const file = path.join(f.photos, filename); const bytes = await image(1800, 1200);
    await writeFile(file, bytes);
    const id = photoId(filename);
    const request = (size: string, etag?: string) => GET(new Request(`http://localhost/api/photos/${id}?size=${size}`, { headers: etag ? { "if-none-match": etag } : {} }), { params: Promise.resolve({ id }) });
    assert.equal((await request("huge")).status, 400);
    const original = await request("original"); assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    const medium = await request("medium"); assert.equal(medium.status, 200);
    assert.equal(medium.headers.get("content-type"), "image/webp");
    assert.equal((await sharp(Buffer.from(await medium.arrayBuffer())).metadata()).width, 800);
    assert.equal((await request("medium", medium.headers.get("etag")!)).status, 304);
    const large = await request("large", medium.headers.get("etag")!); assert.equal(large.status, 200); await large.arrayBuffer();
    assert.equal((await request("original", original.headers.get("etag")!)).status, 304);
    const cancelled = new AbortController(); cancelled.abort();
    const aborted = await GET(new Request(`http://localhost/api/photos/${id}?size=large`, { signal: cancelled.signal }), { params: Promise.resolve({ id }) });
    assert.equal(aborted.status, 503);
    const interrupted = new AbortController();
    const interruptedResponse = await GET(new Request(`http://localhost/api/photos/${id}?size=large`, { signal: interrupted.signal }), { params: Promise.resolve({ id }) });
    interrupted.abort(); await interruptedResponse.body!.cancel().catch(() => {});
    const retry = await request("large"); assert.equal(retry.status, 200); await retry.arrayBuffer();
    const missing = await GET(new Request("http://localhost/api/photos/bad?size=small"), { params: Promise.resolve({ id: "bad" }) });
    assert.equal(missing.status, 404);
  } finally { await f.cleanup(); }
});

test("decode failure cleans partial cache files and doesn't alter an unreadable image", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.photos, "broken.jpg"); await writeFile(file, "malformed JPEG");
    await assert.rejects(variant(file, f.photos, "large"));
    assert.equal((await readFile(file)).toString(), "malformed JPEG");
    const files = await readdir(f.cache, { recursive: true });
    assert.ok(!files.some(name => name.endsWith(".tmp") || name.endsWith(".webp")));
    process.env.PHOTO_CACHE_DIRECTORY = f.photos;
    await assert.rejects(variant(file, f.photos, "small"), /outside/);
  } finally { await f.cleanup(); }
});

test("resize limiter caps active decodes and keeps capacity after errors", async () => {
  const limit = createResizeLimiter(2); let active = 0; let maximum = 0;
  await Promise.allSettled(Array.from({ length: 8 }, (_, index) => limit(async () => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, 10)); if (index === 2) throw new Error("test failure"); }
    finally { active--; }
  })));
  assert.equal(maximum, 2); assert.equal(active, 0);
  assert.equal(await limit(async () => "ready"), "ready");
});
