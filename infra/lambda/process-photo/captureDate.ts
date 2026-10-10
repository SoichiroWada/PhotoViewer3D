import exifr from "exifr";

// Buffer-based port of src/lib/photoDate.ts. Lambda runs in UTC and reserves
// TZ, so offset-free EXIF clocks use an explicit IANA zone instead.
export type PhotoDateSource = "dateTaken" | "dateModified" | "dateUploaded";
export type PhotoDateSelection = { takenAt: string; source: PhotoDateSource | null };
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
  reviveValues: false,
};

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Milliseconds that `timeZone` is ahead of UTC at instant `time`. */
function zoneOffset(time: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(time)).map(part => [part.type, Number(part.value)]));
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(time / 1000) * 1000;
}

function zonedTime(civil: number, timeZone: string): number {
  const first = civil - zoneOffset(civil, timeZone);
  const second = civil - zoneOffset(first, timeZone);
  return second;
}

/** Strict EXIF civil date validation; offsets optional, never guess UTC. */
export function parseCaptureDate(value: unknown, offset: unknown, timeZone: string): Date | undefined {
  if (validDate(value)) return value;
  if (typeof value !== "string") return;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.replace(/\0+$/, "").trim());
  if (!match) return;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
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
  return new Date(zonedTime(civil.getTime(), timeZone));
}

export function selectPhotoDate(
  metadata: CaptureMetadata | undefined,
  info: { mtime?: Date; uploaded?: Date },
  timeZone: string,
): PhotoDateSelection {
  for (const [tag, offset] of [
    ["DateTimeOriginal", "OffsetTimeOriginal"], ["CreateDate", "OffsetTimeDigitized"],
  ] as const) {
    const date = parseCaptureDate(metadata?.[tag], metadata?.[offset], timeZone);
    if (date) return { takenAt: date.toISOString(), source: "dateTaken" };
  }
  if (validDate(info.mtime) && info.mtime.getTime() > 0) return { takenAt: info.mtime.toISOString(), source: "dateModified" };
  if (validDate(info.uploaded)) return { takenAt: info.uploaded.toISOString(), source: "dateUploaded" };
  return { takenAt: new Date(0).toISOString(), source: null };
}

/** Extract only PNG eXIf or WebP EXIF chunks, skipping image payloads. */
function containerExif(bytes: Buffer, webp: boolean): Buffer | undefined {
  const headerLength = webp ? 12 : 8;
  if (bytes.length < headerLength) return;
  if (webp) {
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return;
  } else if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  const end = webp ? Math.min(bytes.readUInt32LE(4) + 8, bytes.length) : bytes.length;
  let offset = headerLength;
  for (let count = 0; count < 512 && offset + 8 <= end; count++) {
    const length = webp ? bytes.readUInt32LE(offset + 4) : bytes.readUInt32BE(offset);
    const name = bytes.toString("ascii", webp ? offset : offset + 4, webp ? offset + 4 : offset + 8);
    const next = offset + 8 + length + (webp ? length % 2 : 4);
    if (next > end + (webp ? 1 : 0)) return;
    if (name === (webp ? "EXIF" : "eXIf")) {
      if (length > 320 * 1024) return;
      const exif = bytes.subarray(offset + 8, offset + 8 + length);
      return exif.subarray(0, 6).equals(Buffer.from("Exif\0\0")) ? exif.subarray(6) : exif;
    }
    if (!webp && name === "IEND") return;
    offset = next;
  }
}

export async function readCaptureMetadata(bytes: Buffer, extension: string): Promise<CaptureMetadata | undefined> {
  try {
    if (extension === ".png" || extension === ".webp") {
      const exif = containerExif(bytes, extension === ".webp");
      return exif ? await exifr.parse(exif, EXIF_OPTIONS) : undefined;
    }
    return await exifr.parse(bytes, EXIF_OPTIONS);
  } catch {
    // Missing, unsupported, or broken EXIF must not drop the photo.
    return undefined;
  }
}
