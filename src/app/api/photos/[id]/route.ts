import { Readable } from "node:stream";
import { openPhoto } from "@/lib/photoLoader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const file = await openPhoto((await params).id);
    if (!file) return new Response("Photo not found", { status: 404 });
    const { handle, info, contentType } = file;
    const etag = `"${info.size}-${Math.trunc(info.mtimeMs)}"`;
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      ETag: etag,
    };
    if (request.headers.get("if-none-match") === etag) {
      await handle.close();
      return new Response(null, { status: 304, headers });
    }
    // Stream originals rather than buffering a whole large image into memory.
    const stream = handle.createReadStream({ autoClose: true });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: { ...headers, "Content-Length": String(info.size) },
    });
  } catch (error) {
    console.error("Photo delivery failed:", error);
    return new Response("Unable to read photo", { status: 503 });
  }
}
