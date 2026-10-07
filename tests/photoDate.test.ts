import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPhotoDateReader, parseCaptureDate, selectPhotoDate } from "../src/lib/photoDate";
import { exifJpeg, exifPng, exifWebp } from "./helpers/exif";

const mtime = new Date("2025-05-06T10:00:00.000Z");
const birthtime = new Date("2020-01-01T00:00:00.000Z");
const invalid = new Date(NaN);

test("DateTimeOriginal outranks CreateDate, mtime, and birthtime", () => {
  assert.deepEqual(selectPhotoDate({ DateTimeOriginal: "2003:06:07 08:09:10", OffsetTimeOriginal: "+09:00", CreateDate: "2010:01:01 00:00:00" }, { mtime, birthtime }),
    { takenAt: "2003-06-06T23:09:10.000Z", source: "dateTaken", exifTag: "DateTimeOriginal" });
  assert.equal(selectPhotoDate({ DateTimeOriginal: "2003:02:30 08:09:10", CreateDate: "2010:01:01 00:00:00", OffsetTimeDigitized: "+00:00" }, { mtime, birthtime }).takenAt, "2010-01-01T00:00:00.000Z");
});

test("strict date validation rejects missing, zero, out-of-range and rolled-over EXIF", () => {
  for (const value of [undefined, invalid, "", "0000:00:00 00:00:00", "2023:02:29 10:00:00", "2024:13:01 10:00:00", "2024:04:31 10:00:00", "2024:01:01 24:00:00", "2024:01:01 12:60:00", "not a date"]) {
    assert.equal(parseCaptureDate(value, undefined), undefined);
    assert.equal(selectPhotoDate({ DateTimeOriginal: value }, { mtime, birthtime }).source, "dateModified");
  }
  assert.equal(parseCaptureDate("2024:02:29 00:30:00", "-03:30")?.toISOString(), "2024-02-29T04:00:00.000Z");
  assert.equal(parseCaptureDate("2024:02:29 00:30:00", undefined)?.getHours(), 0);
});

test("mtime then usable birthtime, preserving files when every date is missing", () => {
  assert.deepEqual(selectPhotoDate(undefined, { mtime, birthtime }), { takenAt: mtime.toISOString(), source: "dateModified" });
  assert.deepEqual(selectPhotoDate(undefined, { mtime: invalid, birthtime }), { takenAt: birthtime.toISOString(), source: "dateCreated" });
  assert.equal(selectPhotoDate(undefined, { birthtime }).source, "dateCreated");
  for (const unsupported of [undefined, invalid, new Date(0)]) {
    assert.deepEqual(selectPhotoDate(undefined, { mtime: invalid, birthtime: unsupported }), { takenAt: "1970-01-01T00:00:00.000Z", source: null });
  }
  assert.equal(selectPhotoDate(undefined, { mtime: new Date(0) }).source, "dateModified");
});

test("actual JPEG, PNG and WebP EXIF parsing, with safe fallback for corrupt images", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "photo-date-"));
  try {
    const reader = createPhotoDateReader();
    for (const [extension, encode] of [["JPG", exifJpeg], ["png", exifPng], ["webp", exifWebp]] as const) {
      const file = path.join(directory, `capture.${extension}`);
      await writeFile(file, encode({ 0x9003: "2004:02:29 12:30:00", 0x9011: "+09:00" }));
      const result = await reader.read(file, await stat(file));
      assert.equal(result.takenAt, "2004-02-29T03:30:00.000Z", extension);
      assert.equal(result.source, "dateTaken");
    }
    const alternate = path.join(directory, "create.jpg");
    await writeFile(alternate, exifJpeg({ 0x9003: "0000:00:00 00:00:00", 0x9004: "2005:01:02 03:04:05", 0x9012: "+00:00" }));
    assert.equal((await reader.read(alternate, await stat(alternate))).exifTag, "CreateDate");
    for (const extension of ["jpg", "png", "webp"]) {
      const broken = path.join(directory, `broken.${extension}`);
      await writeFile(broken, "this is not a valid image or EXIF block");
      const info = await stat(broken);
      assert.deepEqual(await reader.read(broken, info), { takenAt: info.mtime.toISOString(), source: "dateModified" });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unchanged metadata parsing is shared and cached; changes and pruning invalidate it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "photo-date-cache-"));
  try {
    const file = path.join(directory, "cache.jpg");
    await writeFile(file, "fixture");
    const info = await stat(file);
    let calls = 0;
    const reader = createPhotoDateReader(async () => { calls++; return undefined; });
    const [a, b] = await Promise.all([reader.read(file, info), reader.read(file, info)]);
    assert.deepEqual(a, b);
    await reader.read(file, info);
    assert.equal(calls, 1);
    await reader.read(file, { ...info, ctimeMs: info.ctimeMs + 1 });
    assert.equal(calls, 2);
    reader.prune(new Set());
    await reader.read(file, info);
    assert.equal(calls, 3);
    const failing = createPhotoDateReader(async () => { throw new Error("malformed EXIF"); });
    assert.equal((await failing.read(file, info)).source, "dateModified");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
