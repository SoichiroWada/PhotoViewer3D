import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import exifr from "exifr";
import { importPhoto } from "../src/lib/photoImport/importPhoto";
import { readHandleStream } from "../src/lib/photoImport/fileStreams";
import { hashFile } from "../src/lib/photoImport/hashFile";
import { supportedImage } from "../src/lib/photoImport/validateImage";
import { createImportQueue } from "../src/lib/photoImport/importQueue";
import { SourceChangedError } from "../src/lib/photoImport/photoImportTypes";
import { exifJpeg, exifPng, exifWebp } from "./helpers/exif";

const fast = { stabilityMs: 0, pollIntervalMs: 5 };
const photo = (tag = "2004:01:02 03:04:05") => exifJpeg({ 0x9003: tag });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "photo-import-"));
  const incoming = path.join(root, "incoming"); const destination = path.join(root, "photos");
  await mkdir(incoming); await mkdir(destination);
  return { root, incoming, destination, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const missing = async (file: string) => assert.rejects(lstat(file), { code: "ENOENT" });

test("new filename imports without hashing and preserves image bytes, EXIF, mtime, atime, and permissions", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.incoming, "My Holiday Photo.JPG"); const bytes = photo();
    await writeFile(source, bytes); await chmod(source, 0o640);
    const mtime = new Date("2007-02-03T04:05:06.123Z"); const atime = new Date("2006-01-02T03:04:05.000Z");
    await utimes(source, atime, mtime);
    let hashes = 0;
    const result = await importPhoto(source, f.destination, fast, { hash: async file => { hashes++; return hashFile(file); } });
    assert.equal(result.status, "imported"); assert.equal(hashes, 0);
    const target = path.join(f.destination, "My Holiday Photo.JPG");
    const info = await stat(target);
    assert.ok(Math.abs(info.mtimeMs - mtime.getTime()) <= 1);
    assert.ok(Math.abs(info.atimeMs - atime.getTime()) <= 1);
    assert.equal(info.mode & 0o777, 0o640);
    assert.deepEqual(await readFile(target), bytes);
    assert.equal((await exifr.parse(target, ["DateTimeOriginal"])).DateTimeOriginal.getFullYear(), 2004);
    await missing(source); assert.deepEqual(await readdir(f.destination), ["My Holiday Photo.JPG"]);
  } finally { await f.cleanup(); }
});

test("same filename and bytes is an exact duplicate, removed only from incoming", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.incoming, "photo.jpg"); const target = path.join(f.destination, "photo.jpg"); const bytes = photo();
    await writeFile(source, bytes); await writeFile(target, bytes);
    const before = await stat(target);
    const result = await importPhoto(source, f.destination, fast);
    assert.equal(result.status, "duplicate"); await missing(source);
    assert.deepEqual(await readFile(target), bytes);
    assert.equal((await stat(target)).ino, before.ino);
    assert.deepEqual(await readdir(f.destination), ["photo.jpg"]);
  } finally { await f.cleanup(); }
});

test("equal-sized different contents create a numbered name, preserving the old file", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.incoming, "PHOTO.JPG"); const old = photo("2000:01:01 00:00:00"); const bytes = photo("2001:01:01 00:00:00");
    assert.equal(old.length, bytes.length);
    await writeFile(source, bytes); await writeFile(path.join(f.destination, "PHOTO.JPG"), old);
    const result = await importPhoto(source, f.destination, fast);
    assert.equal(result.status, "renamed");
    assert.deepEqual(await readFile(path.join(f.destination, "PHOTO.JPG")), old);
    assert.deepEqual(await readFile(path.join(f.destination, "PHOTO_1.JPG")), bytes);
  } finally { await f.cleanup(); }
});

test("different sizes avoid hashing; multiple occupied suffixes use the next free name", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.incoming, "photo.jpg"); const bytes = photo();
    await writeFile(source, bytes);
    for (const name of ["photo.jpg", "photo_1.jpg", "photo_2.jpg"]) await writeFile(path.join(f.destination, name), Buffer.from("other size"));
    let hashes = 0;
    const result = await importPhoto(source, f.destination, fast, { hash: async file => { hashes++; return hashFile(file); } });
    assert.equal(result.status, "renamed"); assert.equal(hashes, 0);
    assert.deepEqual(await readFile(path.join(f.destination, "photo_3.jpg")), bytes);
  } finally { await f.cleanup(); }
});

test("uppercase JPG/JPEG/PNG/WEBP work; unsupported and malformed files are retained", async () => {
  const f = await fixture();
  try {
    for (const [extension, encode] of [["JPG", exifJpeg], ["JPEG", exifJpeg], ["PNG", exifPng], ["WEBP", exifWebp]] as const) {
      assert.ok(supportedImage(`image.${extension}`));
      const source = path.join(f.incoming, `image.${extension}`);
      await writeFile(source, encode({ 0x9003: "2000:01:01 00:00:00" }));
      assert.equal((await importPhoto(source, f.destination, fast)).status, "imported");
    }
    const unsupported = path.join(f.incoming, "document.txt"); await writeFile(unsupported, "text");
    assert.equal((await importPhoto(unsupported, f.destination, fast)).status, "ignored");
    assert.equal((await readFile(unsupported)).toString(), "text");
    const malformed = path.join(f.incoming, "bad.jpg"); await writeFile(malformed, "bad image");
    await assert.rejects(importPhoto(malformed, f.destination, fast), /signature/);
    assert.equal((await readFile(malformed)).toString(), "bad image");
    const symbolic = path.join(f.incoming, "link.jpg"); await symlink(path.join(f.destination, "image.JPG"), symbolic);
    await assert.rejects(importPhoto(symbolic, f.destination, fast), /regular files/);
    assert.ok((await lstat(symbolic)).isSymbolicLink());
  } finally { await f.cleanup(); }
});

test("streamed large-file hashing uses bounded chunks and the correct digest", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.incoming, "large.jpg"); const handle = await open(file, "wx+");
    try {
      const block = Buffer.alloc(64 * 1024, 73); const expected = createHash("sha256");
      for (let i = 0; i < 256; i++) { await handle.write(block); expected.update(block); }
      let chunks = 0; let largest = 0;
      const digest = await hashFile(handle, input => {
        const stream = readHandleStream(input);
        stream.on("data", chunk => { chunks++; largest = Math.max(largest, Buffer.byteLength(chunk)); });
        return stream;
      });
      assert.equal(digest, expected.digest("hex"));
      assert.ok(chunks > 1); assert.ok(largest <= 64 * 1024);
    } finally { await handle.close(); }
  } finally { await f.cleanup(); }
});

test("concurrent same-name imports cannot overwrite, including identical-content races", async () => {
  const f = await fixture();
  try {
    const other = path.join(f.root, "other"); await mkdir(other);
    const a = path.join(f.incoming, "photo.jpg"); const b = path.join(other, "photo.jpg");
    const bytesA = photo("2000:01:01 00:00:00"); const bytesB = photo("2001:01:01 00:00:00");
    await writeFile(a, bytesA); await writeFile(b, bytesB);
    const results = await Promise.all([importPhoto(a, f.destination, fast), importPhoto(b, f.destination, fast)]);
    assert.deepEqual(results.map(r => r.status).sort(), ["imported", "renamed"]);
    const stored = await Promise.all([readFile(path.join(f.destination, "photo.jpg")), readFile(path.join(f.destination, "photo_1.jpg"))]);
    assert.ok(stored.some(bytes => bytes.equals(bytesA))); assert.ok(stored.some(bytes => bytes.equals(bytesB)));
    await writeFile(a, bytesA); await writeFile(b, bytesA);
    const identical = await Promise.all([importPhoto(a, f.destination, fast), importPhoto(b, f.destination, fast)]);
    assert.ok(identical.every(result => result.status === "duplicate"));
    assert.equal((await readdir(f.destination)).length, 2);
    const c = path.join(f.incoming, "racing.JPG"); const d = path.join(other, "racing.JPG");
    await writeFile(c, bytesA); await writeFile(d, bytesA);
    const racing = await Promise.all([importPhoto(c, f.destination, fast), importPhoto(d, f.destination, fast)]);
    assert.deepEqual(racing.map(r => r.status).sort(), ["duplicate", "imported"]);
    await missing(c); await missing(d);
    assert.equal((await readdir(f.destination)).filter(name => name.startsWith("racing")).length, 1);
  } finally { await f.cleanup(); }
});

test("partial copies stay hidden; copy failure cleans temporary files and retains source", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.incoming, "photo.jpg"); const bytes = photo(); await writeFile(source, bytes);
    await assert.rejects(importPhoto(source, f.destination, fast, { copy: async (_input, output) => {
      await output.write(bytes.subarray(0, 8));
      assert.ok((await readdir(f.destination)).every(name => name.endsWith(".importing")));
      await missing(path.join(f.destination, "photo.jpg"));
      throw new Error("simulated disk-full copy failure");
    } }), /disk-full/);
    assert.deepEqual(await readFile(source), bytes); assert.deepEqual(await readdir(f.destination), []);
    await assert.rejects(importPhoto(source, path.join(f.root, "unavailable"), fast));
    assert.deepEqual(await readFile(source), bytes);
  } finally { await f.cleanup(); }
});

test("source modification or replacement during copying is never deleted or published", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.incoming, "photo.jpg"); await writeFile(source, photo());
    await assert.rejects(importPhoto(source, f.destination, fast, { copy: async (_input, output) => {
      await output.write(photo()); await writeFile(source, photo("2008:01:01 00:00:00"));
    } }), SourceChangedError);
    assert.deepEqual(await readdir(f.destination), []);
    assert.deepEqual(await readFile(source), photo("2008:01:01 00:00:00"));
  } finally { await f.cleanup(); }
});

test("bounded queue continues after a failed job and coalesces duplicate paths", async () => {
  let active = 0; let maximum = 0; const visited: string[] = [];
  const queue = createImportQueue(4, async file => {
    active++; maximum = Math.max(maximum, active); visited.push(file);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    // The watcher normally handles this per-file; test queue's final guard too.
    if (file === "bad") throw new Error("simulated bad job");
  });
  const originalLog = console.error; console.error = () => {};
  try {
    for (let i = 0; i < 20; i++) { queue.enqueue(String(i)); queue.enqueue(String(i)); }
    queue.enqueue("bad"); await queue.whenIdle();
    assert.equal(maximum, 4); assert.ok(visited.includes("19")); assert.ok(visited.includes("bad"));
    assert.ok(visited.filter(file => file === "10").length <= 2);
    await queue.close();
  } finally { console.error = originalLog; }
});
