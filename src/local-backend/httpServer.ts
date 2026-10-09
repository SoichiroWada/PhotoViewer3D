import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Adapt reusable Fetch handlers to Node, retaining streaming and cancellation. */
export function createResponseServer(handler: (request: Request) => Promise<Response>) {
  return createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    incoming.once("aborted", () => controller.abort());
    outgoing.once("close", () => { if (!outgoing.writableFinished) controller.abort(); });
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(new URL(incoming.url ?? "/", "http://127.0.0.1"), {
        method: incoming.method, headers, signal: controller.signal,
      });
      const response = await handler(request);
      if (controller.signal.aborted) { await response.body?.cancel(); return; }
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      if (incoming.method === "HEAD" || !response.body) {
        await response.body?.cancel();
        outgoing.end();
      } else {
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), outgoing);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Local HTTP request failed:", error);
      if (outgoing.headersSent) outgoing.destroy();
      else { outgoing.statusCode = 500; outgoing.end("Unable to serve request"); }
    }
  });
}
