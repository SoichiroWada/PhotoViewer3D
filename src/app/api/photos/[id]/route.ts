import { Readable } from "node:stream";
import { openPhoto } from "@/lib/photoLoader";
import { isPhotoSize } from "@/lib/photoResolution";
import { photoRevision } from "@/lib/photoRevision";
import { openPhotoVariant } from "@/lib/photoVariantCache";
import type { FileHandle } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const size = new URL(request.url).searchParams.get("size") ?? "original";
  if (!isPhotoSize(size)) return new Response("Invalid photo size", { status: 400 });
  let sourceHandle: FileHandle | undefined;
  let deliveryHandle: FileHandle | undefined;
  try {
    request.signal.throwIfAborted();
    const id = (await params).id;
    const file = await openPhoto(id);
    if (!file) return new Response("Photo not found", { status: 404 });
    sourceHandle = file.handle;
    const delivered = size === "original" ? { ...file, etag: `"original-${photoRevision(file.info)}"` } : await openPhotoVariant(id, size, file);
    deliveryHandle = delivered.handle;
    if (size !== "original") await sourceHandle.close();
    sourceHandle = undefined;
    const { handle, info, contentType, etag } = delivered;
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      ETag: etag,
    };
    if (request.headers.get("if-none-match") === etag) {
      await handle.close();
      deliveryHandle = undefined;
      return new Response(null, { status: 304, headers });
    }
    // Both originals and completed disk variants are streamed to the browser.
    request.signal.throwIfAborted();
    const stream = handle.createReadStream({ autoClose: true, signal: request.signal });
    deliveryHandle = undefined; // stream owns this descriptor through completion
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: { ...headers, "Content-Length": String(info.size) },
    });
  } catch (error) {
    if (!request.signal.aborted) console.error("Photo delivery failed:", error);
    return new Response("Unable to read photo", { status: 503 });
  } finally {
    await sourceHandle?.close();
    await deliveryHandle?.close();
  }
}
