import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";
import sharp from "sharp";
import { createLocalPhotoServer } from "../src/local-backend/photoServer";
import { createStaticServer } from "../src/local-backend/staticServer";

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test("separate photo backend streams legacy images and variants with CORS, HEAD, and ETags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "photo-api-server-"));
  const previous = { photos: process.env.PHOTO_DIRECTORY, cache: process.env.PHOTO_CACHE_DIRECTORY };
  const photos = path.join(root, "photos"); await mkdir(photos);
  process.env.PHOTO_DIRECTORY = photos; process.env.PHOTO_CACHE_DIRECTORY = path.join(root, "cache");
  const bytes = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: "#548c84" } }).jpeg().toBuffer();
  await writeFile(path.join(photos, "Memory.jpg"), bytes);
  const server = createLocalPhotoServer(["http://frontend.example.test"]);
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/photos`, { headers: { Origin: "http://frontend.example.test" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://frontend.example.test");
    assert.equal(response.headers.get("vary"), "Origin");
    const catalog = await response.json(); assert.equal(catalog.length, 1);
    assert.deepEqual(await (await fetch(`${base}/api/photos`)).json(), catalog);
    const original = await fetch(base + catalog[0].originalUrl);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    const etag = original.headers.get("etag")!;
    const unchanged = await fetch(base + catalog[0].originalUrl, { headers: { "If-None-Match": etag } });
    assert.equal(unchanged.status, 304); assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    const head = await fetch(base + catalog[0].originalUrl, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const small = await fetch(`${base}/photos/${catalog[0].id}?size=small`);
    assert.equal((await sharp(Buffer.from(await small.arrayBuffer())).metadata()).width, 320);
    assert.equal((await fetch(`${base}/photos/${catalog[0].id}?size=invalid`)).status, 400);
    assert.equal((await fetch(`${base}/photos/invalid`)).status, 404);
    assert.equal((await fetch(`${base}/photos`, { headers: { Origin: "http://untrusted.example.test" } })).status, 403);
    const options = await fetch(`${base}/photos`, { method: "OPTIONS", headers: { Origin: "http://frontend.example.test", "Access-Control-Request-Headers": "If-None-Match" } });
    assert.equal(options.status, 204); assert.equal(options.headers.get("access-control-allow-headers"), "If-None-Match");
    assert.equal((await fetch(`${base}/photos`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally {
    await close(server);
    if (previous.photos === undefined) delete process.env.PHOTO_DIRECTORY; else process.env.PHOTO_DIRECTORY = previous.photos;
    if (previous.cache === undefined) delete process.env.PHOTO_CACHE_DIRECTORY; else process.env.PHOTO_CACHE_DIRECTORY = previous.cache;
    await rm(root, { recursive: true, force: true });
  }
});

test("static preview serves only export files, with no photo API or filesystem escape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "photo-static-server-"));
  const output = path.join(root, "out"); await mkdir(output);
  await writeFile(path.join(output, "index.html"), "<h1>Static corridor shell</h1>");
  await writeFile(path.join(output, "favicon.svg"), "<svg></svg>");
  await writeFile(path.join(root, "secret.txt"), "private");
  await symlink(path.join(root, "secret.txt"), path.join(output, "escaped.txt"));
  const server = await createStaticServer(output);
  try {
    const base = await listen(server);
    const home = await fetch(base);
    assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await home.text(), /Static corridor shell/);
    assert.equal((await fetch(`${base}/favicon.svg`)).headers.get("content-type"), "image/svg+xml");
    const head = await fetch(base, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
    for (const name of ["/api/photos", "/photos", "/escaped.txt", "/%2e%2e%2fsecret.txt"]) {
      assert.equal((await fetch(base + name)).status, 404);
    }
    assert.equal((await fetch(base, { method: "POST" })).status, 405);
  } finally { await close(server); await rm(root, { recursive: true, force: true }); }
});
