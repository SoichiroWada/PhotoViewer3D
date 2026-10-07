import "server-only";
import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import exifr from "exifr";

export type PhotoDateSource = "dateTaken" | "dateModified" | "dateCreated";
export type PhotoDateSelection = {
  takenAt: string;
  source: PhotoDateSource | null;
  exifTag?: "DateTimeOriginal" | "CreateDate";
};
export type FileDates = { mtime?: Date; birthtime?: Date };
export type CaptureMetadata = {
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
  OffsetTimeOriginal?: unknown;
  OffsetTimeDigitized?: unknown;
};

const EXIF_OPTIONS = {
  pick: ["DateTimeOriginal", "CreateDate", "OffsetTimeOriginal", "OffsetTimeDigitized"],
  tiff: true, exif: true, gps: false, ifd1: false, interop: false,
  xmp: false, icc: false, iptc: false, jfif: false, ihdr: false,
  makerNote: false, userComment: false, multiSegment: false,
  // Keep raw dates so impossible calendar dates cannot silently roll over.
  reviveValues: false, chunked: true, firstChunkSize: 512, chunkSize: 65536, chunkLimit: 5,
};

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Strict EXIF civil date validation; offsets optional, never guess UTC. */
export function parseCaptureDate(value: unknown, offset: unknown): Date | undefined {
  if (validDate(value)) return value;
  if (typeof value !== "string") return;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.replace(/\0+$/, "").trim());
  if (!match) return;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return;
  const civil = new Date(0);
  civil.setUTCFullYear(year, month - 1, day);
  civil.setUTCHours(hour, minute, second, 0);
  if (civil.getUTCFullYear() !== year || civil.getUTCMonth() !== month - 1 || civil.getUTCDate() !== day) return;
  if (typeof offset === "string") {
    const zone = /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
    if (zone && Number(zone[2]) <= 14 && Number(zone[3]) <= 59 && (Number(zone[2]) < 14 || Number(zone[3]) === 0)) {
      const minutes = (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === "+" ? 1 : -1);
      return new Date(civil.getTime() - minutes * 60000);
    }
  }
  // Offset-free EXIF dates represent the camera's local clock. Use the server's
  // local timezone, matching exifr's convention, rather than inventing an offset.
  const local = new Date(0);
  local.setFullYear(year, month - 1, day);
  local.setHours(hour, minute, second, 0);
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day || local.getHours() !== hour) return;
  return local;
}

export function selectPhotoDate(metadata: CaptureMetadata | undefined, info: FileDates): PhotoDateSelection {
  for (const [tag, offset] of [
    ["DateTimeOriginal", "OffsetTimeOriginal"], ["CreateDate", "OffsetTimeDigitized"],
  ] as const) {
    const date = parseCaptureDate(metadata?.[tag], metadata?.[offset]);
    if (date) return { takenAt: date.toISOString(), source: "dateTaken", exifTag: tag };
  }
  if (validDate(info.mtime)) return { takenAt: info.mtime.toISOString(), source: "dateModified" };
  // Some Linux filesystems report epoch/zero for unsupported birthtime.
  if (validDate(info.birthtime) && info.birthtime.getTime() > 0) {
    return { takenAt: info.birthtime.toISOString(), source: "dateCreated" };
  }
  // Retain even files with no usable timestamp. Never mislabel this as a source.
  return { takenAt: new Date(0).toISOString(), source: null };
}

/** Extract only PNG eXIf or WebP EXIF; skip image payloads by file offsets. */
async function readContainerExif(filePath: string, webp: boolean): Promise<CaptureMetadata | undefined> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = (await file.stat()).size;
    const signature = Buffer.alloc(webp ? 12 : 8);
    const headerRead = await file.read(signature, 0, signature.length, 0);
    if (headerRead.bytesRead !== signature.length) return;
    if (webp) {
      if (signature.toString("ascii", 0, 4) !== "RIFF" || signature.toString("ascii", 8, 12) !== "WEBP") return;
    } else if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
    const end = webp ? signature.readUInt32LE(4) + 8 : size;
    if (end > size) return;
    const chunkHeader = Buffer.alloc(8);
    let offset = signature.length;
    // Defensive limits for corrupt containers; ordinary files have few chunks.
    for (let count = 0; count < 512 && offset + 8 <= end; count++) {
      if ((await file.read(chunkHeader, 0, 8, offset)).bytesRead !== 8) return;
      const length = webp ? chunkHeader.readUInt32LE(4) : chunkHeader.readUInt32BE(0);
      const name = chunkHeader.toString("ascii", webp ? 0 : 4, webp ? 4 : 8);
      const next = offset + 8 + length + (webp ? length % 2 : 4);
      if (next > end) return;
      if (name === (webp ? "EXIF" : "eXIf")) {
        if (length > 320 * 1024) return;
        let bytes = Buffer.alloc(length);
        if ((await file.read(bytes, 0, length, offset + 8)).bytesRead !== length) return;
        if (bytes.subarray(0, 6).equals(Buffer.from("Exif\0\0"))) bytes = bytes.subarray(6);
        return await exifr.parse(bytes, EXIF_OPTIONS);
      }
      if (!webp && name === "IEND") return;
      offset = next;
    }
  } finally { await file.close(); }
}

async function readCaptureMetadata(filePath: string): Promise<CaptureMetadata | undefined> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png" || extension === ".webp") {
    return readContainerExif(filePath, extension === ".webp");
  }
  // Pass the JPEG disk path, not a readFile buffer: exifr reads bounded chunks.
  return await exifr.parse(filePath, EXIF_OPTIONS);
}

export function createPhotoDateReader(parseMetadata = readCaptureMetadata) {
  const cache = new Map<string, { signature: string; result: Promise<PhotoDateSelection> }>();
  return {
    read(filePath: string, info: Stats): Promise<PhotoDateSelection> {
      // ctime/inode also detect replacements with identical size and mtime.
      const signature = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.birthtimeMs].join(":");
      const cached = cache.get(filePath);
      if (cached?.signature === signature) return cached.result;
      const result = (async () => {
        let metadata: CaptureMetadata | undefined;
        try { metadata = await parseMetadata(filePath); }
        catch { /* Missing, unsupported, or broken EXIF must not drop the photo. */ }
        return selectPhotoDate(metadata, info);
      })();
      cache.set(filePath, { signature, result });
      return result;
    },
    prune(filePaths: Set<string>) {
      for (const filePath of cache.keys()) if (!filePaths.has(filePath)) cache.delete(filePath);
    },
  };
}

export const photoDateReader = createPhotoDateReader();
