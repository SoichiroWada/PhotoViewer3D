import { open, realpath, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { createResponseServer } from "./httpServer";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
};

/** Local preview of export files only: no API proxy and no Next.js runtime. */
export async function createStaticServer(directory: string) {
  const root = await realpath(directory);
  await stat(path.join(root, "index.html"));
  const inside = (value: string) => {
    const relative = path.relative(root, value);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  return createResponseServer(async request => {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    let name: string;
    try { name = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response("Invalid path", { status: 400 }); }
    if (name.includes("\0") || name.includes("\\")) return new Response("Invalid path", { status: 400 });
    let file = path.resolve(root, "." + name);
    if (!inside(file)) return new Response("Not found", { status: 404 });
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = path.join(file, "index.html");
    } catch { /* Missing export routes return 404 rather than the application shell. */ }
    try {
      file = await realpath(file);
      if (!inside(file)) return new Response("Not found", { status: 404 });
      const handle = await open(file, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile()) { await handle.close(); return new Response("Not found", { status: 404 }); }
        const stream = handle.createReadStream({ autoClose: true, signal: request.signal });
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: {
          "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
          "Content-Length": String(info.size), "X-Content-Type-Options": "nosniff",
        } });
      } catch (error) { await handle.close(); throw error; }
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return new Response("Not found", { status: 404 });
      throw error;
    }
  });
}
