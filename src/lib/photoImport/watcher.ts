import chokidar from "chokidar";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createImportQueue } from "./importQueue";
import { importPhoto } from "./importPhoto";
import type { ImportResult, WatcherConfig } from "./photoImportTypes";

export function formatImportLog(result: ImportResult): string {
  const filename = path.basename(result.sourcePath);
  if (result.status === "ignored") return `Ignored unsupported file:\n  ${filename}\n  ${result.reason}`;
  if (result.status === "duplicate") return `Duplicate skipped:\n  ${filename}\n  identical to ${result.destinationPath}`;
  return `${result.status === "renamed" ? "Renamed and imported" : "Imported"}:\n  ${filename}\n  -> ${result.destinationPath}`;
}

function overlapping(a: string, b: string) {
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  };
  return within(a, b) || within(b, a);
}

export async function startPhotoImportWatcher(config: WatcherConfig, logger: (message: string) => void = console.log) {
  if (!path.isAbsolute(config.incomingDirectory) || !path.isAbsolute(config.photoDirectory)) throw new Error("Both photo directories must be absolute paths.");
  if (overlapping(path.resolve(config.incomingDirectory), path.resolve(config.photoDirectory))) throw new Error("Incoming and final directories must not overlap.");
  await mkdir(config.incomingDirectory, { recursive: true });
  await mkdir(config.photoDirectory, { recursive: true });
  const incoming = await realpath(config.incomingDirectory);
  const destination = await realpath(config.photoDirectory);
  if (overlapping(incoming, destination)) throw new Error("Incoming and final directories resolve to overlapping paths.");
  const shutdown = new AbortController();
  const queue = createImportQueue(config.concurrency, async filePath => {
    try {
      const result = await importPhoto(filePath, destination, { stabilityMs: config.stabilityMs, pollIntervalMs: config.pollIntervalMs, signal: shutdown.signal });
      logger(formatImportLog(result));
    } catch (error) {
      logger(`Import failed:\n  ${path.basename(filePath)}\n  reason: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const watcher = chokidar.watch(incoming, {
    depth: 0, ignoreInitial: false, followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: config.stabilityMs, pollInterval: config.pollIntervalMs },
    atomic: true,
  });
  watcher.on("add", filePath => queue.enqueue(filePath));
  watcher.on("change", filePath => queue.enqueue(filePath));
  watcher.on("error", error => logger(`Watcher error: ${error instanceof Error ? error.message : String(error)}`));
  const ready = new Promise<void>(resolve => watcher.once("ready", () => {
    logger(`Watching: ${incoming}\nDestination: ${destination}\nConcurrency: ${config.concurrency}; stability: ${config.stabilityMs} ms`);
    resolve();
  }));
  return {
    ready,
    whenIdle: queue.whenIdle,
    async close() { await watcher.close(); shutdown.abort(); await queue.close(); },
  };
}
