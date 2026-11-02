import sharp from "sharp";
import { PHOTO_WIDTHS, type PhotoTier } from "../../lib/catalog-config";

sharp.cache(false);
sharp.concurrency(2);
const INPUT = { limitInputPixels: 80_000_000 };

/** Lightweight signature check matching src/lib/photoImport/validateImage.ts. */
export function hasValidSignature(bytes: Buffer, extension: string): boolean {
  if (extension === ".jpg" || extension === ".jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (extension === ".png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === ".webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export type RenderedPhoto = { width: number; height: number; variants: Record<PhotoTier, Buffer> };

/** Same recipe as the local variant cache: oriented, lanczos3, WebP q90. */
export async function renderVariants(bytes: Buffer): Promise<RenderedPhoto> {
  const metadata = await sharp(bytes, INPUT).metadata();
  const oriented = metadata.autoOrient ?? { width: metadata.width, height: metadata.height };
  if (!oriented.width || !oriented.height) throw new Error("Image has no dimensions.");
  const entries = await Promise.all((Object.keys(PHOTO_WIDTHS) as PhotoTier[]).map(async tier => [tier,
    await sharp(bytes, INPUT).autoOrient()
      .resize({ width: PHOTO_WIDTHS[tier], withoutEnlargement: true, kernel: "lanczos3", fastShrinkOnLoad: false })
      .webp({ quality: 90, effort: 4, smartSubsample: true })
      .toBuffer(),
  ] as const));
  return { width: oriented.width, height: oriented.height, variants: Object.fromEntries(entries) as Record<PhotoTier, Buffer> };
}
