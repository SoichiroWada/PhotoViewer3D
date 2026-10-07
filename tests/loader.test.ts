import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPhotos, openPhoto, photoId, PhotoDirectoryError } from "../src/lib/photoLoader";

test("catalog sorts files, supports uppercase and spaces, ignores symlinks and rejects unlisted IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "photo-catalog-"));
  const oldSetting = process.env.PHOTO_DIRECTORY;
  try {
    const root = path.join(directory, "photos");
    await mkdir(root);
    for (const [filename, year] of [["older.JPG", 2004], ["newer image.webp", 2024], ["equal.png", 2024], ["ignored.txt", 2025]] as const) {
      const file = path.join(root, filename);
      await writeFile(file, "test image bytes");
      const date = new Date(`${year}-01-01T00:00:00.000Z`);
      await utimes(file, date, date);
    }
    await writeFile(path.join(directory, "outside.jpg"), "outside");
    await symlink(path.join(directory, "outside.jpg"), path.join(root, "link.jpg"));
    process.env.PHOTO_DIRECTORY = root;
    const photos = await loadPhotos();
    assert.deepEqual(photos.map(p => p.filename), ["equal.png", "newer image.webp", "older.JPG"]);
    assert.equal(photos[1].id, photoId("newer image.webp"));
    assert.match(photos[1].thumbnailUrl, /size=small$/);
    assert.match(photos[1].originalUrl, /size=original$/);
    assert.equal(photos[2].takenAt, "2004-01-01T00:00:00.000Z");
    assert.equal(await openPhoto("../../outside.jpg"), null);
    assert.equal(await openPhoto(photoId("link.jpg")), null);
    assert.equal(await openPhoto("0".repeat(24)), null);
    const file = await openPhoto(photos[1].id);
    assert.ok(file);
    assert.equal(file.contentType, "image/webp");
    assert.equal((await file.handle.readFile()).toString(), "test image bytes");
    await file.handle.close();
    await rm(path.join(root, "older.JPG"));
    await symlink(path.join(directory, "outside.jpg"), path.join(root, "older.JPG"));
    assert.equal(await openPhoto(photos[2].id), null);
    process.env.PHOTO_DIRECTORY = directory + "/missing";
    await assert.rejects(loadPhotos(), PhotoDirectoryError);
    process.env.PHOTO_DIRECTORY = "relative/path";
    await assert.rejects(loadPhotos(), PhotoDirectoryError);
    process.env.PHOTO_DIRECTORY = directory;
    // Unsupported files removed yields a valid empty catalog.
    await rm(path.join(directory, "outside.jpg"));
    assert.deepEqual(await loadPhotos(), []);
  } finally {
    if (oldSetting === undefined) delete process.env.PHOTO_DIRECTORY;
    else process.env.PHOTO_DIRECTORY = oldSetting;
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog sorts by selected EXIF dates and retains malformed metadata with filesystem fallback", async () => {
  const { exifJpeg } = await import("./helpers/exif");
  const { loadPhotoDateDiagnostics } = await import("../src/lib/photoLoader");
  const directory = await mkdtemp(path.join(os.tmpdir(), "photo-date-catalog-"));
  const oldSetting = process.env.PHOTO_DIRECTORY;
  try {
    const fixtures = [
      { name: "capture.jpg", bytes: exifJpeg({ 0x9003: "2020:01:01 00:00:00", 0x9011: "+00:00", 0x9004: "2005:01:01 00:00:00" }), modified: "2000-01-01" },
      { name: "modified.jpg", bytes: Buffer.from("broken EXIF"), modified: "2010-01-01" },
      { name: "create.jpeg", bytes: exifJpeg({ 0x9003: "2023:02:30 00:00:00", 0x9004: "2005:01:01 00:00:00", 0x9012: "+00:00" }), modified: "2025-01-01" },
      { name: "old.JPG", bytes: exifJpeg({ 0x9003: "1980:01:01 00:00:00", 0x9011: "+00:00" }), modified: "2030-01-01" },
    ];
    for (const fixture of fixtures) {
      const file = path.join(directory, fixture.name);
      await writeFile(file, fixture.bytes);
      const date = new Date(fixture.modified + "T00:00:00.000Z");
      await utimes(file, date, date);
    }
    process.env.PHOTO_DIRECTORY = directory;
    const photos = await loadPhotos();
    assert.deepEqual(photos.map(photo => photo.filename), ["capture.jpg", "modified.jpg", "create.jpeg", "old.JPG"]);
    assert.deepEqual(photos.map(photo => photo.takenAt), ["2020-01-01T00:00:00.000Z", "2010-01-01T00:00:00.000Z", "2005-01-01T00:00:00.000Z", "1980-01-01T00:00:00.000Z"]);
    assert.deepEqual(Object.keys(photos[0]).sort(), ["filename", "id", "originalUrl", "takenAt", "thumbnailUrl"]);
    const diagnostics = await loadPhotoDateDiagnostics();
    assert.deepEqual(diagnostics.map(entry => entry.source), ["dateTaken", "dateModified", "dateTaken", "dateTaken"]);
    assert.equal(diagnostics[2].exifTag, "CreateDate");
  } finally {
    if (oldSetting === undefined) delete process.env.PHOTO_DIRECTORY;
    else process.env.PHOTO_DIRECTORY = oldSetting;
    await rm(directory, { recursive: true, force: true });
  }
});
