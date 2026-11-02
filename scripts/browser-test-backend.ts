import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createLocalPhotoServer } from "../src/local-backend/photoServer";

// Isolated browser fixtures: never scan or write the user's configured photos.
async function main() {
  const apiBase = new URL(process.env.TEST_API_BASE_URL ?? "http://127.0.0.1:4000");
  const root = await mkdtemp(path.join(os.tmpdir(), "photo-viewer-browser-"));
  const directory = path.join(root, "photos"); await mkdir(directory);
  process.env.PHOTO_DIRECTORY = directory;
  process.env.PHOTO_CACHE_DIRECTORY = path.join(root, "cache");
  let server: ReturnType<typeof createLocalPhotoServer> | undefined;
  try {
    for (let index = 0; index < 12; index++) {
      const file = path.join(directory, `Memory-${String(index).padStart(2, "0")}.jpg`);
      await sharp({ create: { width: 2400, height: 1600, channels: 3,
        background: { r: 65 + index * 10, g: 130, b: 160 - index * 5 } } }).jpeg().toFile(file);
      const date = new Date(Date.UTC(2025 - Math.floor(index / 2), 0, 2 - index % 2));
      await utimes(file, date, date);
    }
    const frontendOrigin = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000").origin;
    server = createLocalPhotoServer([frontendOrigin, "http://localhost:3000"]);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(Number(apiBase.port || 4000), "127.0.0.1", resolve);
    });
    console.log(`Browser fixture backend: ${apiBase.origin}/photos`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void stop().catch(console.error); });
  } catch (error) { server?.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
