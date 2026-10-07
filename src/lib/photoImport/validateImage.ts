import path from "node:path";
import type { FileHandle } from "node:fs/promises";

export function supportedImage(filename: string): boolean {
  return [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(filename).toLowerCase());
}

/** Lightweight format signature check; does not decode/rewrite photo pixels. */
export async function validateImage(handle: FileHandle, filename: string) {
  const header = Buffer.alloc(12);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  const extension = path.extname(filename).toLowerCase();
  const valid = extension === ".jpg" || extension === ".jpeg"
    ? bytesRead >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255
    : extension === ".png"
      ? bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytesRead === 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error(`Invalid or mismatched image signature for ${filename}.`);
}
