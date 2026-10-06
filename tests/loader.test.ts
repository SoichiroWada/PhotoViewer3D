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
    assert.equal(photos[1].thumbnailUrl, photos[1].originalUrl);
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
