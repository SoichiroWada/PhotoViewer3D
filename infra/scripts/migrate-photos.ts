/**
 * Migrates a local photo directory into the deployed stack by uploading each
 * file to the upload bucket's incoming/ prefix, where the ProcessPhoto Lambda
 * catalogs it exactly like a browser upload. File mtimes travel as metadata
 * so photos without EXIF dates keep their local ordering.
 *
 *   AWS_PROFILE=<profile> npm run migrate -- --source /path/to/photos [--limit N] [--dry-run]
 *   AWS_PROFILE=<profile> npm run migrate -- --verify --source /path/to/photos --local-api http://127.0.0.1:4100
 *
 * Re-running is safe: files whose content is already cataloged are skipped,
 * and ProcessPhoto deduplicates by SHA-256 regardless.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, QueryCommand, type BatchGetCommandOutput, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { INCOMING_PREFIX, MAX_UPLOAD_BYTES, PHOTO_COLLECTION_ID, PHOTO_INDEX_NAME, SUPPORTED_TYPES } from "../lib/catalog-config";

const { values: args } = parseArgs({ options: {
  source: { type: "string" },
  stack: { type: "string", default: "PhotoViewer3D" },
  limit: { type: "string" },
  concurrency: { type: "string", default: "4" },
  "dry-run": { type: "boolean", default: false },
  verify: { type: "boolean", default: false },
  "local-api": { type: "string" },
} });

type LocalPhoto = { file: string; name: string; size: number; mtime: Date; photoId: string };

async function stackOutputs(stackName: string) {
  const result = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Object.fromEntries((result.Stacks?.[0]?.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
  for (const key of ["UploadBucketName", "PhotoTableName"]) if (!outputs[key]) throw new Error(`Stack output ${key} is missing.`);
  return outputs as Record<"UploadBucketName" | "PhotoTableName", string>;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Non-recursive, like the local backend; symlinks and unsupported files are skipped. */
async function scan(directory: string): Promise<LocalPhoto[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const photos: LocalPhoto[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || !SUPPORTED_TYPES[path.extname(entry.name).toLowerCase()]) continue;
    const file = path.join(directory, entry.name);
    const info = await stat(file);
    if (info.size === 0 || info.size > MAX_UPLOAD_BYTES) { console.warn(`skip (size ${info.size}): ${entry.name}`); continue; }
    photos.push({ file, name: entry.name, size: info.size, mtime: info.mtime, photoId: (await hashFile(file)).slice(0, 32) });
  }
  return photos.sort((a, b) => a.name.localeCompare(b.name));
}

async function existingIds(db: DynamoDBDocumentClient, table: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let index = 0; index < ids.length; index += 100) {
    let keys: Record<string, unknown>[] | undefined = ids.slice(index, index + 100).map(photoId => ({ photoId }));
    for (let attempt = 0; keys?.length && attempt < 5; attempt++) {
      const result: BatchGetCommandOutput = await db.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ProjectionExpression: "photoId" } } }));
      for (const item of result.Responses?.[table] ?? []) found.add(item.photoId as string);
      keys = result.UnprocessedKeys?.[table]?.Keys;
    }
    if (keys?.length) throw new Error("DynamoDB left keys unprocessed; retry later.");
  }
  return found;
}

async function catalog(db: DynamoDBDocumentClient, table: string) {
  const items: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const result: QueryCommandOutput = await db.send(new QueryCommand({
      TableName: table, IndexName: PHOTO_INDEX_NAME, KeyConditionExpression: "collectionId = :c",
      ExpressionAttributeValues: { ":c": PHOTO_COLLECTION_ID }, ScanIndexForward: false, ExclusiveStartKey: key,
    }));
    items.push(...(result.Items ?? []));
    key = result.LastEvaluatedKey;
  } while (key);
  return items;
}

async function upload(s3: S3Client, bucket: string, photos: LocalPhoto[], concurrency: number) {
  let next = 0; let done = 0; const failures: string[] = [];
  const worker = async () => {
    while (next < photos.length) {
      const photo = photos[next++]!;
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          // The photoId segment keeps keys unique even for identical filenames.
          Key: `${INCOMING_PREFIX}migration/${photo.photoId}/${photo.name}`,
          Body: createReadStream(photo.file), ContentLength: photo.size,
          ContentType: SUPPORTED_TYPES[path.extname(photo.name).toLowerCase()],
          Metadata: { mtime: photo.mtime.toISOString(), uploader: "migration" },
        }));
      } catch (error) {
        failures.push(`${photo.name}: ${error instanceof Error ? error.message : error}`);
      }
      done++;
      if (done % 25 === 0 || done === photos.length) console.log(`uploaded ${done}/${photos.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, photos.length) }, worker));
  return failures;
}

/** Compares the AWS catalog with the local backend's /photos (filename + takenAt). */
async function verify(db: DynamoDBDocumentClient, table: string, photos: LocalPhoto[]) {
  const items = await catalog(db, table);
  const byId = new Map(items.map(item => [item.photoId as string, item]));
  const missing = photos.filter(photo => !byId.has(photo.photoId));
  const localIds = new Set(photos.map(photo => photo.photoId));
  const extra = items.filter(item => !localIds.has(item.photoId as string));
  const sources: Record<string, number> = {};
  for (const item of items) sources[String(item.dateSource)] = (sources[String(item.dateSource)] ?? 0) + 1;
  console.log(`local files: ${photos.length} (unique content: ${localIds.size}); catalog: ${items.length}; date sources:`, sources);
  console.log(`missing from catalog: ${missing.length}${missing.length ? " → " + missing.slice(0, 10).map(p => p.name).join(", ") : ""}`);
  console.log(`in catalog but not local: ${extra.length}${extra.length ? " → " + extra.slice(0, 10).map(i => i.filename).join(", ") : ""}`);
  let mismatches = 0;
  if (args["local-api"]) {
    const response = await fetch(new URL("photos", args["local-api"].replace(/\/?$/, "/")));
    const local = await response.json() as { filename: string; takenAt: string }[];
    const localDates = new Map(local.map(photo => [photo.filename, photo.takenAt]));
    for (const photo of photos) {
      const item = byId.get(photo.photoId);
      const expected = localDates.get(photo.name);
      // Identical-content copies share one record; compare only the copy that was kept.
      if (item && item.filename === photo.name && expected && item.takenAt !== expected) {
        if (mismatches++ < 10) console.log(`date mismatch ${photo.name}: local ${expected} aws ${item.takenAt}`);
      }
    }
    // The viewer orders newest first; compare the full sequences, too.
    const awsOrder = items.map(item => item.takenAt as string);
    const kept = new Set(items.map(item => item.filename as string));
    const localOrder = local.filter(photo => kept.has(photo.filename)).map(photo => photo.takenAt).sort().reverse();
    const sameOrder = awsOrder.length === localOrder.length && awsOrder.every((value, index) => value === localOrder[index]);
    console.log(`takenAt mismatches vs local backend: ${mismatches}; newest-first date sequence identical: ${sameOrder}`);
  }
  return missing.length === 0 && extra.length === 0 && mismatches === 0;
}

async function main() {
  if (!args.source) throw new Error("--source <photo directory> is required.");
  const outputs = await stackOutputs(args.stack!);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  console.log(`scanning ${args.source} …`);
  const photos = await scan(path.resolve(args.source));
  if (args.verify) { process.exitCode = await verify(db, outputs.PhotoTableName, photos) ? 0 : 1; return; }

  const unique = [...new Map(photos.map(photo => [photo.photoId, photo])).values()];
  const already = await existingIds(db, outputs.PhotoTableName, unique.map(photo => photo.photoId));
  let pending = unique.filter(photo => !already.has(photo.photoId));
  if (args.limit) pending = pending.slice(0, Number(args.limit));
  const bytes = pending.reduce((sum, photo) => sum + photo.size, 0);
  console.log(`files: ${photos.length}, identical-content duplicates: ${photos.length - unique.length}, already cataloged: ${already.size}`);
  console.log(`to upload: ${pending.length} (${(bytes / 1024 / 1024).toFixed(1)} MiB) → s3://${outputs.UploadBucketName}/${INCOMING_PREFIX}migration/`);
  if (args["dry-run"] || !pending.length) return;
  const failures = await upload(new S3Client({}), outputs.UploadBucketName, pending, Number(args.concurrency));
  if (failures.length) { console.error(`${failures.length} uploads failed:\n${failures.join("\n")}`); process.exitCode = 1; }
  console.log("Uploads finished. ProcessPhoto catalogs them within about a minute; then run with --verify.");
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
