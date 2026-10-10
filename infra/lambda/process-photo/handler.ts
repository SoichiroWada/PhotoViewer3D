import { createHash } from "node:crypto";
import path from "node:path";
import type { S3Event } from "aws-lambda";
import { INCOMING_PREFIX, MAX_UPLOAD_BYTES, MEDIA_PREFIX, PHOTO_COLLECTION_ID, SUPPORTED_TYPES, type PhotoTier } from "../../lib/catalog-config";
import { readCaptureMetadata, selectPhotoDate } from "./captureDate";
import { hasValidSignature, type RenderedPhoto } from "./image";

export type IncomingObject = { bytes: Buffer; lastModified?: Date; metadata: Record<string, string> };
export type ProcessDependencies = {
  getIncoming(bucket: string, key: string): Promise<IncomingObject | undefined>;
  deleteIncoming(bucket: string, key: string): Promise<void>;
  putMedia(key: string, body: Buffer, contentType: string): Promise<void>;
  photoExists(photoId: string): Promise<boolean>;
  /** Returns false when a concurrent upload already created the record. */
  putCatalog(item: Record<string, unknown>): Promise<boolean>;
  render(bytes: Buffer): Promise<RenderedPhoto>;
  timeZone: string;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn" | "error">;
};
export type ProcessResult = { status: "imported" | "duplicate" | "rejected" | "skipped"; key: string; photoId?: string; reason?: string };

/** S3 event keys are form-encoded (`+` is a space). */
export function decodeS3Key(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, " "));
}

export async function processObject(bucket: string, key: string, deps: ProcessDependencies): Promise<ProcessResult> {
  const log = deps.logger ?? console;
  if (!key.startsWith(INCOMING_PREFIX) || key.endsWith("/")) return { status: "skipped", key, reason: "Not an incoming photo" };
  const filename = path.basename(key);
  const extension = path.extname(filename).toLowerCase();
  const contentType = SUPPORTED_TYPES[extension];
  const reject = async (reason: string): Promise<ProcessResult> => {
    // Definitive validation failures are removed so retries cannot loop.
    log.warn("Rejected incoming photo", { key, reason });
    await deps.deleteIncoming(bucket, key);
    return { status: "rejected", key, reason };
  };
  if (!contentType) return reject("Unsupported extension");
  const object = await deps.getIncoming(bucket, key);
  if (!object) return { status: "skipped", key, reason: "Already processed" };
  if (object.bytes.length === 0 || object.bytes.length > MAX_UPLOAD_BYTES) return reject("Invalid size");
  if (!hasValidSignature(object.bytes, extension)) return reject("Invalid or mismatched image signature");

  const sha256 = createHash("sha256").update(object.bytes).digest("hex");
  // Content addressing makes duplicate detection and retries idempotent.
  const photoId = sha256.slice(0, 32);
  if (await deps.photoExists(photoId)) {
    await deps.deleteIncoming(bucket, key);
    log.info("Duplicate photo skipped", { key, photoId });
    return { status: "duplicate", key, photoId };
  }

  const mtime = object.metadata.mtime ? new Date(object.metadata.mtime) : undefined;
  const date = selectPhotoDate(await readCaptureMetadata(object.bytes, extension), { mtime, uploaded: object.lastModified }, deps.timeZone);
  const rendered = await deps.render(object.bytes);

  const originalKey = `${MEDIA_PREFIX}/originals/${photoId}${extension === ".jpeg" ? ".jpg" : extension}`;
  const variantKeys = Object.fromEntries((Object.keys(rendered.variants) as PhotoTier[])
    .map(tier => [tier, `${MEDIA_PREFIX}/variants/${photoId}/${tier}.webp`])) as Record<PhotoTier, string>;
  await deps.putMedia(originalKey, object.bytes, contentType);
  await Promise.all((Object.keys(variantKeys) as PhotoTier[]).map(tier => deps.putMedia(variantKeys[tier], rendered.variants[tier], "image/webp")));

  const created = await deps.putCatalog({
    photoId, collectionId: PHOTO_COLLECTION_ID, takenAtKey: `${date.takenAt}#${photoId}`,
    filename, takenAt: date.takenAt, ...(date.source ? { dateSource: date.source } : {}),
    originalKey, smallKey: variantKeys.small, mediumKey: variantKeys.medium, largeKey: variantKeys.large,
    sha256, width: rendered.width, height: rendered.height, size: object.bytes.length,
    uploadedBy: object.metadata.uploader ?? "unknown", importedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  await deps.deleteIncoming(bucket, key);
  if (!created) return { status: "duplicate", key, photoId };
  log.info("Photo imported", { key, photoId, takenAt: date.takenAt, dateSource: date.source });
  return { status: "imported", key, photoId };
}

export function createProcessHandler(deps: ProcessDependencies) {
  return async (event: S3Event) => {
    const results: ProcessResult[] = [];
    // Unexpected errors propagate so Lambda retries; the upload stays in incoming/.
    for (const record of event.Records) {
      results.push(await processObject(record.s3.bucket.name, decodeS3Key(record.s3.object.key), deps));
    }
    return results;
  };
}
