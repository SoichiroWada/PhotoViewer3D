import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import type { S3Event } from "aws-lambda";
import { parseCaptureDate, readCaptureMetadata, selectPhotoDate } from "../lambda/process-photo/captureDate";
import { createProcessHandler, decodeS3Key, processObject, type ProcessDependencies } from "../lambda/process-photo/handler";
import { renderVariants } from "../lambda/process-photo/image";
import { exifJpeg, exifPng, exifWebp } from "./helpers/exif";

const DATE_TIME_ORIGINAL = 0x9003;
const OFFSET_TIME_ORIGINAL = 0x9011;
const quiet = { info() {}, warn() {}, error() {} };

/** A real decodable JPEG carrying a hand-built EXIF APP1 segment. */
async function photo(tags: Record<number, string> = {}, width = 2000, height = 1000) {
  const jpeg = await sharp({ create: { width, height, channels: 3, background: "#4080c0" } }).jpeg().toBuffer();
  if (!Object.keys(tags).length) return jpeg;
  return Buffer.concat([jpeg.subarray(0, 2), exifJpeg(tags).subarray(2, -2), jpeg.subarray(2)]);
}

function fakes(objects: Record<string, { bytes: Buffer; metadata?: Record<string, string>; lastModified?: Date }>) {
  const media = new Map<string, { body: Buffer; contentType: string }>();
  const catalog = new Map<string, Record<string, unknown>>();
  const deleted: string[] = [];
  const deps: ProcessDependencies = {
    timeZone: "Asia/Tokyo",
    logger: quiet,
    now: () => new Date("2026-10-11T00:00:00.000Z"),
    render: renderVariants,
    async getIncoming(_bucket, key) {
      const object = objects[key];
      return object && { bytes: object.bytes, metadata: object.metadata ?? {}, lastModified: object.lastModified };
    },
    async deleteIncoming(_bucket, key) { deleted.push(key); delete objects[key]; },
    async putMedia(key, body, contentType) { media.set(key, { body, contentType }); },
    async photoExists(photoId) { return catalog.has(photoId); },
    async putCatalog(item) {
      if (catalog.has(item.photoId as string)) return false;
      catalog.set(item.photoId as string, item); return true;
    },
  };
  return { deps, media, catalog, deleted };
}

test("offset-free EXIF dates use the configured zone, including DST transitions", () => {
  assert.equal(parseCaptureDate("2021:03:27 14:30:00", undefined, "Asia/Tokyo")?.toISOString(), "2021-03-27T05:30:00.000Z");
  assert.equal(parseCaptureDate("2021:03:14 03:30:00", undefined, "America/New_York")?.toISOString(), "2021-03-14T07:30:00.000Z");
  assert.equal(parseCaptureDate("2021:07:01 12:00:00", undefined, "America/New_York")?.toISOString(), "2021-07-01T16:00:00.000Z");
  assert.equal(parseCaptureDate("2021:03:27 14:30:00", "+02:00", "Asia/Tokyo")?.toISOString(), "2021-03-27T12:30:00.000Z");
  for (const invalid of ["2021:02:30 10:00:00", "2021:13:01 10:00:00", "0000:00:00 00:00:00", "garbage"]) {
    assert.equal(parseCaptureDate(invalid, undefined, "Asia/Tokyo"), undefined, invalid);
  }
});

test("date selection falls back from EXIF to uploaded mtime to S3 upload time", () => {
  const mtime = new Date("2019-05-05T05:05:05.000Z");
  const uploaded = new Date("2026-10-11T00:00:00.000Z");
  assert.deepEqual(selectPhotoDate({ DateTimeOriginal: "2020:01:02 03:04:05" }, { mtime, uploaded }, "UTC"),
    { takenAt: "2020-01-02T03:04:05.000Z", source: "dateTaken" });
  assert.deepEqual(selectPhotoDate({ CreateDate: "bad" }, { mtime, uploaded }, "UTC"), { takenAt: mtime.toISOString(), source: "dateModified" });
  assert.deepEqual(selectPhotoDate(undefined, { uploaded }, "UTC"), { takenAt: uploaded.toISOString(), source: "dateUploaded" });
  assert.deepEqual(selectPhotoDate(undefined, {}, "UTC"), { takenAt: "1970-01-01T00:00:00.000Z", source: null });
});

test("reads capture dates from JPEG, PNG eXIf and WebP EXIF containers", async () => {
  const tags = { [DATE_TIME_ORIGINAL]: "2018:08:08 08:08:08" };
  for (const [bytes, extension] of [[exifJpeg(tags), ".jpg"], [exifPng(tags), ".png"], [exifWebp(tags), ".webp"]] as const) {
    assert.equal((await readCaptureMetadata(bytes, extension))?.DateTimeOriginal, "2018:08:08 08:08:08", extension);
  }
  assert.equal(await readCaptureMetadata(Buffer.from("not an image"), ".png"), undefined);
});

test("imports a photo: content-addressed media, oriented variants, catalog record, incoming removed", async () => {
  const key = "incoming/uuid-1/IMG 0001.JPG";
  const bytes = await photo({ [DATE_TIME_ORIGINAL]: "2021:03:27 14:30:00", [OFFSET_TIME_ORIGINAL]: "+09:00" });
  const { deps, media, catalog, deleted } = fakes({ [key]: { bytes, metadata: { uploader: "user-sub" } } });
  const result = await processObject("upload-bucket", key, deps);
  assert.equal(result.status, "imported");
  const id = result.photoId!;
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.deepEqual([...media.keys()].sort(), [
    `media/originals/${id}.jpg`, `media/variants/${id}/large.webp`, `media/variants/${id}/medium.webp`, `media/variants/${id}/small.webp`,
  ]);
  assert.ok(media.get(`media/originals/${id}.jpg`)!.body.equals(bytes));
  for (const [tier, width] of [["small", 320], ["medium", 800], ["large", 1600]] as const) {
    const info = await sharp(media.get(`media/variants/${id}/${tier}.webp`)!.body).metadata();
    assert.equal(info.format, "webp"); assert.equal(info.width, width);
  }
  assert.deepEqual(catalog.get(id), {
    photoId: id, collectionId: "default", takenAtKey: `2021-03-27T05:30:00.000Z#${id}`, filename: "IMG 0001.JPG",
    takenAt: "2021-03-27T05:30:00.000Z", dateSource: "dateTaken", originalKey: `media/originals/${id}.jpg`,
    smallKey: `media/variants/${id}/small.webp`, mediumKey: `media/variants/${id}/medium.webp`, largeKey: `media/variants/${id}/large.webp`,
    sha256: catalog.get(id)!.sha256, width: 2000, height: 1000, size: bytes.length, uploadedBy: "user-sub", importedAt: "2026-10-11T00:00:00.000Z",
  });
  assert.deepEqual(deleted, [key]);
});

test("small photos are never enlarged", async () => {
  const rendered = await renderVariants(await photo({}, 500, 400));
  assert.equal((await sharp(rendered.variants.small).metadata()).width, 320);
  assert.equal((await sharp(rendered.variants.large).metadata()).width, 500);
});

test("duplicate content is detected by hash and the redundant upload removed", async () => {
  const bytes = await photo();
  const { deps, catalog, deleted } = fakes({ "incoming/a/one.jpg": { bytes }, "incoming/b/copy.jpg": { bytes } });
  assert.equal((await processObject("b", "incoming/a/one.jpg", deps)).status, "imported");
  const second = await processObject("b", "incoming/b/copy.jpg", deps);
  assert.equal(second.status, "duplicate");
  assert.equal(catalog.size, 1);
  assert.deepEqual(deleted, ["incoming/a/one.jpg", "incoming/b/copy.jpg"]);
});

test("rejects unsupported or mismatched files without touching media or catalog", async () => {
  const { deps, media, catalog, deleted } = fakes({
    "incoming/a/notes.txt": { bytes: Buffer.from("hi") },
    "incoming/b/fake.png": { bytes: await photo() },
  });
  assert.equal((await processObject("b", "incoming/a/notes.txt", deps)).status, "rejected");
  assert.equal((await processObject("b", "incoming/b/fake.png", deps)).status, "rejected");
  assert.equal(media.size + catalog.size, 0);
  assert.deepEqual(deleted.sort(), ["incoming/a/notes.txt", "incoming/b/fake.png"]);
  assert.equal((await processObject("b", "media/originals/x.jpg", deps)).status, "skipped");
  assert.equal((await processObject("b", "incoming/missing.jpg", deps)).status, "skipped");
});

test("undecodable images propagate so Lambda retries and the upload is kept", async () => {
  const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)]);
  const { deps, deleted } = fakes({ "incoming/a/broken.jpg": { bytes: broken } });
  await assert.rejects(processObject("b", "incoming/a/broken.jpg", deps));
  assert.deepEqual(deleted, []);
});

test("S3 event keys are form-decoded before processing", async () => {
  assert.equal(decodeS3Key("incoming/u/My+Photo%E2%80%99s+%281%29.jpg"), "incoming/u/My Photo’s (1).jpg");
  const { deps } = fakes({ "incoming/u/a b.jpg": { bytes: await photo() } });
  const event = { Records: [{ s3: { bucket: { name: "b" }, object: { key: "incoming/u/a+b.jpg" } } }] } as unknown as S3Event;
  const [result] = await createProcessHandler(deps)(event);
  assert.equal(result!.status, "imported");
});
