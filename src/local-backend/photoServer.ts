import { GET as getPhotos } from "./routes/photos";
import { GET as getPhoto } from "./routes/photo";
import { createResponseServer } from "./httpServer";

export const DEFAULT_PHOTO_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

export function createLocalPhotoServer(allowedOrigins: string[] = DEFAULT_PHOTO_ORIGINS) {
  const origins = new Set(allowedOrigins.map(value => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) {
      throw new Error("PHOTO_API_ALLOWED_ORIGINS must contain exact HTTP/HTTPS origins.");
    }
    return value;
  }));
  return createResponseServer(async request => {
    const origin = request.headers.get("origin");
    if (origin && !origins.has(origin)) return new Response("Origin not allowed", { status: 403 });
    const cors = origin ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "If-None-Match",
      "Access-Control-Expose-Headers": "ETag",
      Vary: "Origin",
    } : { Vary: "Origin" };
    let response: Response;
    if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
    else if (!["GET", "HEAD"].includes(request.method)) {
      response = new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
    } else {
      const pathname = new URL(request.url).pathname;
      const image = /^\/(?:api\/)?photos\/([^/]+)$/.exec(pathname);
      if (/^\/(?:api\/)?photos\/?$/.test(pathname)) response = await getPhotos();
      else if (image) response = await getPhoto(request, { params: Promise.resolve({ id: image[1] }) });
      else response = new Response("Not found", { status: 404 });
    }
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  });
}
