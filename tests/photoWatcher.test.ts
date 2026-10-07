import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startPhotoImportWatcher } from "../src/lib/photoImport/watcher";
import { exifJpeg } from "./helpers/exif";

async function until(condition: () => Promise<boolean>, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Watcher did not reach the expected state.");
}

test("watcher handles initial and chunked files, duplicates, and isolated failures without Next.js", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "photo-watch-"));
  const incoming = path.join(root, "incoming"); const destination = path.join(root, "photos");
  await mkdir(incoming); await mkdir(destination);
  const initial = exifJpeg({ 0x9003: "2004:01:01 00:00:00" });
  await writeFile(path.join(incoming, "existing.JPG"), initial);
  const logs: string[] = [];
  const config = { incomingDirectory: incoming, photoDirectory: destination, concurrency: 2, stabilityMs: 180, pollIntervalMs: 20 };
  const watcher = await startPhotoImportWatcher(config, message => logs.push(message));
  try {
    await watcher.ready;
    await until(async () => (await readdir(destination)).includes("existing.JPG"));
    assert.deepEqual(await readFile(path.join(destination, "existing.JPG")), initial);
    assert.ok(logs.some(log => log.startsWith("Imported:")));
    const large = Buffer.concat([initial, Buffer.alloc(1024 * 1024, 31)]);
    const source = path.join(incoming, "chunked.JPG");
    await writeFile(source, large.subarray(0, 500000));
    await new Promise(resolve => setTimeout(resolve, 100));
    await appendFile(source, large.subarray(500000, 750000));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(!(await readdir(destination)).includes("chunked.JPG"));
    await appendFile(source, large.subarray(750000));
    await until(async () => (await readdir(destination)).includes("chunked.JPG"));
    await watcher.whenIdle();
    assert.deepEqual(await readFile(path.join(destination, "chunked.JPG")), large);
    await writeFile(path.join(incoming, "bad.jpg"), "not an image");
    await writeFile(path.join(incoming, "document.txt"), "text");
    await writeFile(path.join(incoming, "existing.JPG"), initial);
    await until(async () => logs.some(log => log.startsWith("Duplicate skipped:")) && logs.some(log => log.includes("bad.jpg")) && logs.some(log => log.startsWith("Ignored unsupported file:")));
    assert.ok((await lstat(path.join(incoming, "bad.jpg"))).isFile());
    assert.ok((await lstat(path.join(incoming, "document.txt"))).isFile());
    assert.equal((await readdir(destination)).filter(name => name === "existing.JPG").length, 1);
  } finally { await watcher.close(); await rm(root, { recursive: true, force: true }); }
});

test("watcher rejects overlapping directories before accepting work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "photo-watch-paths-"));
  try {
    const config = { incomingDirectory: root, photoDirectory: path.join(root, "photos"), concurrency: 4, stabilityMs: 100, pollIntervalMs: 20 };
    await assert.rejects(startPhotoImportWatcher(config), /overlap/);
    await assert.rejects(startPhotoImportWatcher({ ...config, incomingDirectory: "relative" }), /absolute/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("standalone command loads configuration, imports without Next.js, and shuts down gracefully", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "photo-watch-cli-"));
  const incoming = path.join(root, "incoming"); const destination = path.join(root, "photos");
  await mkdir(incoming); await mkdir(destination);
  try {
    const rejected = spawnSync("npm", ["run", "photo-watch"], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PHOTO_INCOMING_DIRECTORY: root, PHOTO_DIRECTORY: root },
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Incoming and final directories must not overlap/);

    const bytes = exifJpeg({ 0x9003: "2004:01:01 00:00:00" });
    await writeFile(path.join(incoming, "CLI photo.JPG"), bytes);
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/photo-import-watcher.ts"], {
      env: { ...process.env, PHOTO_INCOMING_DIRECTORY: incoming, PHOTO_DIRECTORY: destination,
        PHOTO_IMPORT_STABILITY_MS: "500", PHOTO_IMPORT_POLL_MS: "50", PHOTO_IMPORT_CONCURRENCY: "4" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      await until(async () => output.includes("Imported:") && (await readdir(incoming)).length === 0);
      assert.deepEqual(await readFile(path.join(destination, "CLI photo.JPG")), bytes);
      child.kill("SIGTERM");
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.match(output, /Stopping watcher; finishing active imports/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
